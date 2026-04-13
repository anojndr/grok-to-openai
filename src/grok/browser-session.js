import fs from "node:fs/promises";
import { chromium } from "playwright-core";
import { readCookiesFromSource } from "../lib/cookies.js";

export const ERROR_RESPONSE_TEXT_LIMIT = 128 * 1024;

function clearTextBuffer(buffer) {
  buffer.chunks.length = 0;
  buffer.length = 0;
}

function setTextBufferLimit(buffer, limit) {
  buffer.limit = limit;

  if (limit === 0) {
    clearTextBuffer(buffer);
    return;
  }

  if (Number.isFinite(limit) && buffer.length > limit) {
    const trimmed = buffer.chunks.join("").slice(0, limit);
    buffer.chunks.length = 0;
    if (trimmed) {
      buffer.chunks.push(trimmed);
    }
    buffer.length = trimmed.length;
  }
}

function appendTextChunk(buffer, chunk) {
  if (!chunk || buffer.limit === 0) {
    return;
  }

  if (!Number.isFinite(buffer.limit)) {
    buffer.chunks.push(chunk);
    buffer.length += chunk.length;
    return;
  }

  const remaining = buffer.limit - buffer.length;
  if (remaining <= 0) {
    return;
  }

  const nextChunk = chunk.slice(0, remaining);
  if (!nextChunk) {
    return;
  }

  buffer.chunks.push(nextChunk);
  buffer.length += nextChunk.length;
}

export class BrowserSession {
  constructor(config) {
    this.config = config;
    this.context = null;
    this.page = null;
    this.pageUserAgent = null;
    this.pending = new Map();
    this.statsigChunkSource = null;
    this.bindingsInstalled = false;
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
      await this.ensurePage();
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

    await this.installBindings();

    if (this.config.importCookiesOnBoot) {
      const cookies = Array.isArray(this.config.grokCookies)
        ? this.config.grokCookies
        : await readCookiesFromSource({
            filePath: this.config.grokCookieFile,
            rawText: this.config.grokCookiesText
          });

      if (cookies.length) {
        await this.context.addCookies(cookies);
      }
    }

    await this.ensurePage();
  }

  async installBindings() {
    if (this.bindingsInstalled) {
      return;
    }

    await this.context.exposeBinding("__grokBridgeMeta", (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      pending?.onMeta(payload);
    });

    await this.context.exposeBinding("__grokBridgeChunk", (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      pending?.onChunk(payload.chunk);
    });

    await this.context.exposeBinding("__grokBridgeDone", (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      if (!pending) {
        return;
      }

      this.pending.delete(payload.requestId);
      pending.resolve();
    });

    await this.context.exposeBinding("__grokBridgeError", (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      if (!pending) {
        return;
      }

      this.pending.delete(payload.requestId);
      pending.reject(new Error(payload.message));
    });

    await this.context.addInitScript(() => {
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
          let statsigId;
          try {
            const generator = await window.__grokBridgeEnsureStatsigGenerator(
              request.statsigChunkSource
            );
            statsigId = await generator(url.pathname, request.method);
          } catch (error) {
            statsigId = btoa(`e:${String(error)}`);
          }
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

    this.bindingsInstalled = true;
  }

  async ensurePage() {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }

    const page = await this.context.newPage();
    this.page = page;
    page.on("close", () => {
      if (this.page === page) {
        this.page = null;
        this.pageUserAgent = null;
      }
    });
    await page.goto(this.config.grokBaseUrl, {
      waitUntil: "domcontentloaded"
    });

    try {
      this.pageUserAgent = await page.evaluate(() => navigator.userAgent);
    } catch {
      this.pageUserAgent = null;
    }

    return page;
  }

  async recreatePage() {
    if (this.page && !this.page.isClosed()) {
      await this.page.close().catch(() => {});
    }
    this.page = null;
    return this.ensurePage();
  }

  async evaluateRequest(page, payload) {
    return page.evaluate((requestPayload) => window.__grokBridgeFetch(requestPayload), payload);
  }

  async request({
    requestId,
    url,
    method = "GET",
    body = null,
    headers = {},
    onChunk = null,
    onMeta = null
  }) {
    await this.init();
    const statsigChunkSource = await this.loadStatsigChunkSource();

    let meta = null;
    const textBuffer = {
      chunks: [],
      length: 0,
      limit: onChunk ? 0 : Number.POSITIVE_INFINITY
    };
    const payload = {
      requestId,
      url,
      method,
      body,
      headers,
      statsigChunkSource
    };

    const run = async (page) => {
      await new Promise((resolve, reject) => {
        this.pending.set(requestId, {
          onMeta(payload) {
            meta = payload;

            if (payload.status >= 400) {
              setTextBufferLimit(textBuffer, ERROR_RESPONSE_TEXT_LIMIT);
            } else if (onChunk) {
              setTextBufferLimit(textBuffer, 0);
            }

            onMeta?.(payload);
          },
          onChunk(chunk) {
            appendTextChunk(textBuffer, chunk);
            onChunk?.(chunk);
          },
          resolve,
          reject
        });

        this.evaluateRequest(page, payload).catch((error) => {
          this.pending.delete(requestId);
          reject(error);
        });
      });
    };

    try {
      const page = await this.ensurePage();
      await run(page);
    } catch (error) {
      this.pending.delete(requestId);

      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("Execution context was destroyed") ||
        message.includes("Most likely because of a navigation") ||
        message.includes("Target closed")
      ) {
        meta = null;
        setTextBufferLimit(
          textBuffer,
          onChunk ? 0 : Number.POSITIVE_INFINITY
        );
        clearTextBuffer(textBuffer);
        const page = await this.recreatePage();
        await run(page);
      } else {
        throw error;
      }
    }

    return {
      meta,
      text: textBuffer.chunks.join("")
    };
  }

  async fetchAsset(url) {
    await this.init();

    const headers = {
      Accept: "*/*",
      Referer: this.config.grokBaseUrl
    };
    const cookies = await this.context.cookies(url);

    if (cookies.length) {
      headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    }

    if (!this.pageUserAgent) {
      try {
        const page = await this.ensurePage();
        this.pageUserAgent = await page.evaluate(() => navigator.userAgent);
      } catch {
        // Fall back to Node's default user agent if page access fails.
      }
    }

    if (this.pageUserAgent) {
      headers["User-Agent"] = this.pageUserAgent;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Asset fetch failed with status ${response.status}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());

    return {
      contentType: response.headers.get("content-type") || "application/octet-stream",
      bytes
    };
  }

  async fetchBase64(url) {
    const asset = await this.fetchAsset(url);

    return {
      contentType: asset.contentType,
      base64: asset.bytes.toString("base64")
    };
  }

  async close() {
    await this.context?.close();
    this.context = null;
    this.page = null;
    this.pageUserAgent = null;
  }
}
