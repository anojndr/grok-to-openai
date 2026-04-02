import fs from "node:fs/promises";
import { chromium } from "playwright-core";
import { readCookiesFromSource } from "../lib/cookies.js";

export class BrowserSession {
  constructor(config) {
    this.config = config;
    this.context = null;
    this.page = null;
    this.pending = new Map();
    this.statsigChunkSource = null;
  }

  async loadStatsigChunkSource() {
    if (this.statsigChunkSource) {
      return this.statsigChunkSource;
    }

    const response = await fetch(
      "https://cdn.grok.com/_next/static/chunks/1fe28994d9ee9e6a.js"
    );
    this.statsigChunkSource = await response.text();
    return this.statsigChunkSource;
  }

  async init() {
    if (this.context) {
      return;
    }

    if (this.config.browserProfileDir) {
      await fs.mkdir(this.config.browserProfileDir, { recursive: true });
    }

    this.context = await chromium.launchPersistentContext(
      this.config.browserProfileDir,
      {
        headless: this.config.headless,
        executablePath: this.config.chromeExecutablePath || undefined
      }
    );

    this.page =
      this.context.pages()[0] ??
      (await this.context.newPage());

    await this.page.exposeBinding("__grokBridgeMeta", (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      pending?.onMeta(payload);
    });

    await this.page.exposeBinding("__grokBridgeChunk", (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      pending?.onChunk(payload.chunk);
    });

    await this.page.exposeBinding("__grokBridgeDone", (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      if (!pending) {
        return;
      }

      this.pending.delete(payload.requestId);
      pending.resolve();
    });

    await this.page.exposeBinding("__grokBridgeError", (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      if (!pending) {
        return;
      }

      this.pending.delete(payload.requestId);
      pending.reject(new Error(payload.message));
    });

    await this.page.addInitScript(() => {
      window.__grokBridgeEnsureStatsigGenerator = async (scriptSource) => {
        if (window.__grokStatsigGen) {
          return window.__grokStatsigGen;
        }

        const previous = globalThis.TURBOPACK;
        let moduleFactory = null;
        globalThis.TURBOPACK = {
          push(args) {
            for (let index = 1; index < args.length; index += 2) {
              if (args[index] === 880932) {
                moduleFactory = args[index + 1];
              }
            }
          }
        };

        try {
          (0, eval)(scriptSource);
        } finally {
          globalThis.TURBOPACK = previous;
        }

        if (!moduleFactory) {
          throw new Error("Unable to load Grok statsig middleware");
        }

        const exports = {};
        moduleFactory({
          s(defs) {
            for (let index = 0; index < defs.length; index += 2) {
              Object.defineProperty(exports, defs[index], {
                enumerable: true,
                get: defs[index + 1]
              });
            }
          }
        });

        window.__grokStatsigGen = exports.default();
        return window.__grokStatsigGen;
      };

      window.__grokBridgeFetch = async (request) => {
        try {
          const url = new URL(request.url, location.origin);
          const generator = await window.__grokBridgeEnsureStatsigGenerator(
            request.statsigChunkSource
          );
          const statsigId = await generator(url.pathname, request.method);
          const headers = new Headers(request.headers || {});
          headers.set("x-xai-request-id", crypto.randomUUID());
          headers.set("x-statsig-id", statsigId);

          const response = await fetch(request.url, {
            method: request.method,
            headers,
            body: request.body ? JSON.stringify(request.body) : undefined,
            credentials: "include"
          });

          const responseHeaders = {};
          response.headers.forEach((value, key) => {
            responseHeaders[key] = value;
          });

          await window.__grokBridgeMeta({
            requestId: request.requestId,
            status: response.status,
            headers: responseHeaders
          });

          if (!response.body) {
            await window.__grokBridgeDone({ requestId: request.requestId });
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();

          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }

            const chunk = decoder.decode(value, { stream: true });
            if (chunk) {
              await window.__grokBridgeChunk({
                requestId: request.requestId,
                chunk
              });
            }
          }

          const finalChunk = decoder.decode();
          if (finalChunk) {
            await window.__grokBridgeChunk({
              requestId: request.requestId,
              chunk: finalChunk
            });
          }

          await window.__grokBridgeDone({ requestId: request.requestId });
        } catch (error) {
          await window.__grokBridgeError({
            requestId: request.requestId,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      };
    });

    if (this.config.importCookiesOnBoot) {
      const cookies = await readCookiesFromSource({
        filePath: this.config.grokCookieFile,
        rawText: this.config.grokCookiesText
      });

      if (cookies.length) {
        await this.context.addCookies(cookies);
      }
    }

    await this.page.goto(this.config.grokBaseUrl, {
      waitUntil: "domcontentloaded"
    });
  }

  async request({ requestId, url, method = "GET", body = null, headers = {} }) {
    await this.init();
    const statsigChunkSource = await this.loadStatsigChunkSource();

    let meta = null;
    const chunks = [];

    await new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        onMeta(payload) {
          meta = payload;
        },
        onChunk(chunk) {
          chunks.push(chunk);
        },
        resolve,
        reject
      });

      this.page
        .evaluate((payload) => window.__grokBridgeFetch(payload), {
          requestId,
          url,
          method,
          body,
          headers,
          statsigChunkSource
        })
        .catch(reject);
    });

    return {
      meta,
      text: chunks.join("")
    };
  }

  async close() {
    await this.context?.close();
    this.context = null;
    this.page = null;
  }
}
