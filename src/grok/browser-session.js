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

function installGrokBridgePageHelpers() {
  const getBinding = (name) => {
    if (typeof window[name] === "function") {
      return window[name];
    }

    const legacyName = name.startsWith("__") ? name.slice(2) : "";
    if (legacyName && typeof window[legacyName] === "function") {
      return window[legacyName];
    }

    return null;
  };

  const callBinding = async (name, payload) => {
    const binding = getBinding(name);
    if (!binding) {
      throw new Error(`window.${name} is not a function`);
    }

    await binding(payload);
  };

  window.__grokBridgeGetBinding = getBinding;
  window.grokBridgeGetBinding = getBinding;
  window.__grokBridgeCallBinding = callBinding;
  window.grokBridgeCallBinding = callBinding;

  if (typeof window.__grokBridgeEnsureStatsigGenerator !== "function") {
    const ensureStatsigGenerator = async (scriptSource) => {
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

    window.__grokBridgeEnsureStatsigGenerator = ensureStatsigGenerator;
    window.grokBridgeEnsureStatsigGenerator = ensureStatsigGenerator;
  }

  if (typeof window.__grokBridgeFetch === "function") {
    if (typeof window.grokBridgeFetch !== "function") {
      window.grokBridgeFetch = window.__grokBridgeFetch;
    }
    return;
  }

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

      await window.__grokBridgeCallBinding("__grokBridgeMeta", {
        requestId: request.requestId,
        status: response.status,
        headers: responseHeaders
      });

      if (!response.body) {
        await window.__grokBridgeCallBinding("__grokBridgeDone", {
          requestId: request.requestId
        });
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
          await window.__grokBridgeCallBinding("__grokBridgeChunk", {
            requestId: request.requestId,
            chunk
          });
        }
      }

      const finalChunk = decoder.decode();
      if (finalChunk) {
        await window.__grokBridgeCallBinding("__grokBridgeChunk", {
          requestId: request.requestId,
          chunk: finalChunk
        });
      }

      await window.__grokBridgeCallBinding("__grokBridgeDone", {
        requestId: request.requestId
      });
    } catch (error) {
      try {
        await window.__grokBridgeCallBinding("__grokBridgeError", {
          requestId: request.requestId,
          message: error instanceof Error ? error.message : String(error)
        });
      } catch {
        throw error;
      }
    }
  };

  window.grokBridgeFetch = window.__grokBridgeFetch;
}

function isRecoverablePageError(message) {
  return (
    message.includes("Execution context was destroyed") ||
    message.includes("Most likely because of a navigation") ||
    message.includes("Target closed") ||
    ((message.includes("__grokBridge") || message.includes("grokBridge")) &&
      (message.includes("is not a function") ||
        message.includes("is undefined")))
  );
}

function isPrimaryNavigationResponse(page, response) {
  if (!response) {
    return false;
  }

  const request = typeof response.request === "function" ? response.request() : null;
  const frame = typeof response.frame === "function" ? response.frame() : null;
  const mainFrame = typeof page.mainFrame === "function" ? page.mainFrame() : null;

  if (mainFrame && frame && frame !== mainFrame) {
    return false;
  }

  if (!request) {
    return true;
  }

  if (typeof request.isNavigationRequest === "function" && request.isNavigationRequest()) {
    return true;
  }

  if (typeof request.resourceType === "function" && request.resourceType() === "document") {
    return true;
  }

  return false;
}

function getResponseStatus(response) {
  if (!response) {
    return 0;
  }

  return typeof response.status === "function" ? response.status() : response.status;
}

function getResponseHeaders(response) {
  if (!response) {
    return {};
  }

  return typeof response.headers === "function" ? response.headers() : (response.headers ?? {});
}

export class BrowserSession {
  constructor(config) {
    this.config = config;
    this.context = null;
    this.page = null;
    this.pagePromise = null;
    this.pageUserAgent = null;
    this.pending = new Map();
    this.statsigChunkSource = null;
    this.bindingsInstalled = false;
    this.initPromise = null;
  }

  resetContextState() {
    this.context = null;
    this.page = null;
    this.pagePromise = null;
    this.pageUserAgent = null;
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

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    const initPromise = (async () => {
      if (this.context) {
        await this.ensurePage();
        return;
      }

      if (this.config.browserProfileDir) {
        await fs.mkdir(this.config.browserProfileDir, { recursive: true });
      }

      const context = await chromium.launchPersistentContext(
        this.config.browserProfileDir,
        {
          headless: this.config.headless,
          executablePath: this.config.chromeExecutablePath || undefined
        }
      );
      this.context = context;

      try {
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
      } catch (error) {
        await context.close().catch(() => {});
        if (this.context === context) {
          this.resetContextState();
        }
        throw error;
      }
    })();

    this.initPromise = initPromise;

    try {
      await initPromise;
    } finally {
      if (this.initPromise === initPromise) {
        this.initPromise = null;
      }
    }
  }

  async installBindings() {
    if (this.bindingsInstalled) {
      return;
    }

    const exposeAliases = async (names, handler) => {
      for (const name of names) {
        await this.context.exposeBinding(name, handler);
      }
    };

    await exposeAliases(["__grokBridgeMeta", "grokBridgeMeta"], (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      pending?.onMeta(payload);
    });

    await exposeAliases(["__grokBridgeChunk", "grokBridgeChunk"], (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      pending?.onChunk(payload.chunk);
    });

    await exposeAliases(["__grokBridgeDone", "grokBridgeDone"], (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      if (!pending) {
        return;
      }

      this.pending.delete(payload.requestId);
      pending.resolve();
    });

    await exposeAliases(["__grokBridgeError", "grokBridgeError"], (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      if (!pending) {
        return;
      }

      this.pending.delete(payload.requestId);
      pending.reject(new Error(payload.message));
    });

    await this.context.addInitScript(installGrokBridgePageHelpers);

    this.bindingsInstalled = true;
  }

  async ensurePage() {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }

    if (this.pagePromise) {
      return this.pagePromise;
    }

    const pagePromise = (async () => {
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
    })();

    this.pagePromise = pagePromise;

    try {
      return await pagePromise;
    } finally {
      if (this.pagePromise === pagePromise) {
        this.pagePromise = null;
      }
    }
  }

  async recreatePage() {
    if (this.page && !this.page.isClosed()) {
      await this.page.close().catch(() => {});
    }
    this.page = null;
    return this.ensurePage();
  }

  async evaluateRequest(page, payload) {
    await page.evaluate(installGrokBridgePageHelpers);
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
      if (isRecoverablePageError(message)) {
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
    const page = await this.context.newPage();
    const navigationResponses = [];
    const captureResponse = (response) => {
      if (isPrimaryNavigationResponse(page, response)) {
        navigationResponses.push(response);
      }
    };

    page.on("response", captureResponse);

    try {
      const initialResponse = await page.goto(url, {
        waitUntil: "commit"
      });

      try {
        await page.waitForLoadState("networkidle", {
          timeout: 5000
        });
      } catch {
        // Some asset hosts never fully settle; use the latest navigation response we saw.
      }

      const response = navigationResponses.at(-1) ?? initialResponse;
      const status = getResponseStatus(response);
      if (!status) {
        throw new Error("Asset fetch failed without a response");
      }

      if (status >= 400) {
        throw new Error(`Asset fetch failed with status ${status}`);
      }

      const bytes = Buffer.from(await response.body());
      const headers = getResponseHeaders(response);

      return {
        contentType:
          headers["content-type"] ||
          headers["Content-Type"] ||
          "application/octet-stream",
        bytes
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async fetchBase64(url) {
    const asset = await this.fetchAsset(url);

    return {
      contentType: asset.contentType,
      base64: asset.bytes.toString("base64")
    };
  }

  async close() {
    const initPromise = this.initPromise;
    if (initPromise) {
      await initPromise.catch(() => {});
    }

    await this.context?.close();
    this.resetContextState();
  }
}
