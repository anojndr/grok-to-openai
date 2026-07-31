import fs from "node:fs/promises";
import { chromium } from "playwright-core";
import { HttpError } from "../lib/errors.js";
import { readCookiesFromSource } from "../lib/cookies.js";

export const ERROR_RESPONSE_TEXT_LIMIT = 128 * 1024;
export const GROK_SESSION_BLOCKED_ERROR_CODE = "grok_session_blocked";

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

export function installGrokBridgePageHelpers() {
  if (typeof window.__grokBridgeFetch === "function") {
    window.grokBridgeFetch = window.__grokBridgeFetch;
    return;
  }

  // Element caching to survive anti-bot DOM removal
  const savedElements = [];

  const handleNode = (node) => {
    if (node.nodeType !== 1) return;
    try {
      if (node.querySelector('path[d]')) {
        if (!savedElements.some(el => el.isEqualNode(node))) {
          savedElements.push(node.cloneNode(true));
        }
      }
    } catch (e) {}

    // Check descendants
    try {
      const descendants = node.querySelectorAll('*');
      for (const desc of descendants) {
        if (desc.querySelector('path[d]')) {
          if (!savedElements.some(el => el.isEqualNode(desc))) {
            savedElements.push(desc.cloneNode(true));
          }
        }
      }
    } catch (e) {}
  };

  // Initial scan in case document is already partially parsed
  try {
    const all = document.querySelectorAll('*');
    for (const node of all) {
      if (node.querySelector('path[d]')) {
        if (!savedElements.some(el => el.isEqualNode(node))) {
          savedElements.push(node.cloneNode(true));
        }
      }
    }
  } catch (e) {}

  // Observe DOM additions dynamically
  try {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes) {
          for (const node of mutation.addedNodes) {
            handleNode(node);
          }
        }
      }
    });
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true
    });
    if (window.__grokVerbose) {
      console.log("__grokBridge: MutationObserver started.");
    }
  } catch (e) {
    if (window.__grokVerbose) {
      console.error("__grokBridge: Failed to start MutationObserver:", e);
    }
  }

  // Hook query selectors to return cached elements when they are queried but missing from DOM
  try {
    const originalQuerySelectorAll = document.querySelectorAll;
    document.querySelectorAll = function(selector) {
      const result = originalQuerySelectorAll.apply(this, arguments);
      if (result.length === 0 && savedElements.length) {
        const matched = [];
        for (const el of savedElements) {
          try {
            if (el.matches(selector)) {
              matched.push(el);
            }
          } catch (e) {}
        }
        if (matched.length) {
          return matched;
        }
      }
      return result;
    };

    const originalQuerySelector = document.querySelector;
    document.querySelector = function(selector) {
      const result = originalQuerySelector.apply(this, arguments);
      if (!result && savedElements.length) {
        for (const el of savedElements) {
          try {
            if (el.matches(selector)) {
              return el;
            }
          } catch (e) {}
        }
      }
      return result;
    };

    const originalGetElementsByClassName = document.getElementsByClassName;
    document.getElementsByClassName = function(className) {
      const result = originalGetElementsByClassName.apply(this, arguments);
      if (result.length === 0 && savedElements.length) {
        const matched = [];
        for (const el of savedElements) {
          try {
            if (el.classList && el.classList.contains(className)) {
              matched.push(el);
            }
          } catch (e) {}
        }
        if (matched.length) {
          return matched;
        }
      }
      return result;
    };
  } catch (e) {}

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
    const ensureStatsigGenerator = async (scriptUrl, targetModuleId) => {
      if (window.__grokStatsigGen) {
        return window.__grokStatsigGen;
      }

      const previous = globalThis.TURBOPACK;
      let moduleFactory = null;

      const interceptPromise = new Promise((resolve, reject) => {
        globalThis.TURBOPACK = {
          push(args) {
            if (args.length === 3 && (args[1] === targetModuleId || args[1] === Number(targetModuleId))) {
              moduleFactory = args[2];
            } else {
              for (let index = 1; index < args.length; index += 2) {
                if (args[index] === targetModuleId || args[index] === Number(targetModuleId)) {
                  moduleFactory = args[index + 1];
                }
              }
            }
            if (previous && typeof previous.push === "function") {
              previous.push(args);
            } else if (Array.isArray(previous)) {
              previous.push(args);
            }
            if (moduleFactory) {
              resolve();
            }
          }
        };

        const script = document.createElement("script");
        script.src = scriptUrl;
        script.onload = () => {
          if (!moduleFactory) {
            reject(new Error("Script loaded but module " + targetModuleId + " was not intercepted"));
          }
        };
        script.onerror = (e) => {
          reject(new Error("Failed to load script: " + scriptUrl));
        };
        document.head.appendChild(script);
      });

      try {
        await interceptPromise;
      } finally {
        globalThis.TURBOPACK = previous;
      }

      if (!moduleFactory) {
        throw new Error("Unable to load Grok statsig middleware for module " + targetModuleId);
      }

      const exports = {};
      const W = {
        s(defs) {
          if (Array.isArray(defs)) {
            const name = defs[0];
            const getter = defs[2] || defs[1];
            Object.defineProperty(exports, name, {
              enumerable: true,
              get: getter
            });
            return;
          }
        }
      };

      try {
        moduleFactory(W);
      } catch (e) {
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
      }

      let gen = exports.default;
      if (typeof gen === "function") {
        try {
          const res = gen();
          if (typeof res === "function") {
            gen = res;
          }
        } catch (e) {}
      }
      window.__grokStatsigGen = gen;
      return window.__grokStatsigGen;
    };

    window.__grokBridgeEnsureStatsigGenerator = ensureStatsigGenerator;
    window.grokBridgeEnsureStatsigGenerator = ensureStatsigGenerator;
  }

  window.__grokBridgeFetch = async (request) => {
    try {
      const url = new URL(request.url, location.origin);
      let statsigId;
      try {
        if (window.__grokVerbose) {
          console.log("__grokBridgeFetch: statsig generator cache size:", savedElements.length);
        }
        const generator = await window.__grokBridgeEnsureStatsigGenerator(
          request.statsigChunkUrl,
          request.statsigModuleId
        );
        statsigId = await generator(url.pathname, request.method);
        if (window.__grokVerbose) {
          console.log("__grokBridgeFetch: Generated statsigId successfully:", statsigId);
        }
      } catch (error) {
        statsigId = btoa(`e:${String(error)}`);
        if (window.__grokVerbose) {
          console.error("__grokBridgeFetch: Failed to generate statsigId:", error);
        }
      }
      const headers = new Headers(request.headers || {});
      headers.set("x-xai-request-id", crypto.randomUUID());
      headers.set("x-statsig-id", statsigId);

      if (window.__grokVerbose) {
        console.log("__grokBridgeFetch Request URL:", request.url);
        console.log("__grokBridgeFetch Request Method:", request.method);
        console.log("__grokBridgeFetch Request Headers:", JSON.stringify(request.headers));
        console.log("__grokBridgeFetch Request Body:", JSON.stringify(request.body));
      }

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
      const requestedBatchMaxChars = Number(request.streamBatchMaxChars);
      const requestedBatchDelayMs = Number(request.streamBatchDelayMs);
      const batchMaxChars =
        Number.isFinite(requestedBatchMaxChars) && requestedBatchMaxChars > 0
          ? Math.floor(requestedBatchMaxChars)
          : 16384;
      const batchDelayMs =
        Number.isFinite(requestedBatchDelayMs) && requestedBatchDelayMs >= 0
          ? requestedBatchDelayMs
          : 2;
      let bufferedChunk = "";
      let flushTimer = null;
      let flushError = null;
      let flushChain = Promise.resolve();

      const flushBufferedChunk = () => {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }

        if (!bufferedChunk || flushError) {
          return flushChain;
        }

        const chunk = bufferedChunk;
        bufferedChunk = "";
        flushChain = flushChain
          .then(() => window.__grokBridgeCallBinding("__grokBridgeChunk", {
            requestId: request.requestId,
            chunk
          }))
          .catch((error) => {
            flushError ??= error;
          });

        return flushChain;
      };

      const queueChunk = async (chunk) => {
        if (!chunk) {
          return;
        }

        bufferedChunk += chunk;
        if (bufferedChunk.length >= batchMaxChars) {
          await flushBufferedChunk();
          if (flushError) {
            throw flushError;
          }
          return;
        }

        if (flushTimer === null) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            flushBufferedChunk();
          }, batchDelayMs);
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        await queueChunk(chunk);
      }

      const finalChunk = decoder.decode();
      await queueChunk(finalChunk);
      await flushBufferedChunk();
      if (flushError) {
        throw flushError;
      }

      await window.__grokBridgeCallBinding("__grokBridgeDone", {
        requestId: request.requestId
      });
    } catch (error) {
      try {
        const errorMsg = error instanceof Error ? `${error.name}: ${error.message}\nStack: ${error.stack}` : String(error);
        await window.__grokBridgeCallBinding("__grokBridgeError", {
          requestId: request.requestId,
          message: errorMsg
        });
      } catch {
        throw error;
      }
    }
  };

  window.grokBridgeFetch = window.__grokBridgeFetch;
}

function isRecoverablePageError(message) {
  const normalized = String(message || "").toLowerCase();

  return (
    normalized.includes("execution context was destroyed") ||
    normalized.includes("most likely because of a navigation") ||
    normalized.includes("target closed") ||
    normalized.includes("target page, context or browser has been closed") ||
    ((normalized.includes("__grokbridge") || normalized.includes("grokbridge")) &&
      (normalized.includes("is not a function") ||
        normalized.includes("is undefined")))
  );
}

export function isRecoverableContextError(message) {
  const normalized = String(message || "").toLowerCase();

  if (normalized.includes("target page, context or browser has been closed")) {
    return false;
  }

  return (
    normalized.includes("target.createtarget") ||
    normalized.includes("failed to open a new tab") ||
    normalized.includes("browsercontext.newpage") ||
    normalized.includes("browser has been closed") ||
    normalized.includes("context has been closed") ||
    normalized.includes("connection closed") ||
    (normalized.includes("protocol error") &&
      (normalized.includes("target") ||
        normalized.includes("context") ||
        normalized.includes("browser") ||
        normalized.includes("page")))
  );
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function isCloudflareBlockText(text = "") {
  const normalized = String(text).toLowerCase();

  return (
    normalized.includes("attention required! | cloudflare") ||
    normalized.includes("sorry, you have been blocked") ||
    normalized.includes("checking if the site connection is secure") ||
    normalized.includes("cf-error-details") ||
    normalized.includes("cloudflare ray id")
  );
}

function createSessionBlockedError(reason) {
  return new HttpError(
    502,
    `Grok session is blocked or not authenticated: ${reason}`,
    {
      code: GROK_SESSION_BLOCKED_ERROR_CODE
    }
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

async function getResponseBody(response) {
  if (!response) {
    return Buffer.alloc(0);
  }

  const body =
    typeof response.body === "function" ? await response.body() : response.body;

  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

const globalStatsigCache = new Map();

export class BrowserSession {
  constructor(config) {
    this.config = config;
    this.context = null;
    this.page = null;
    this.pagePromise = null;
    this.pageUserAgent = null;
    this.pending = new Map();
    this.statsigChunkUrl = null;
    this.statsigModuleId = null;
    this.statsigPromise = null;
    this.bindingsInstalled = false;
    this.initPromise = null;
    this.validatedPage = null;
    this.validatedPageUrl = null;
  }

  resetContextState() {
    this.context = null;
    this.page = null;
    this.pagePromise = null;
    this.pageUserAgent = null;
    this.statsigChunkUrl = null;
    this.statsigModuleId = null;
    this.statsigPromise = null;
    this.bindingsInstalled = false;
    this.validatedPage = null;
    this.validatedPageUrl = null;
  }

  async loadStatsigChunkSource() {
    if (this.statsigChunkUrl && this.statsigModuleId) {
      return {
        url: this.statsigChunkUrl,
        moduleId: this.statsigModuleId
      };
    }

    const cacheKey = this.config.grokBaseUrl;
    const cached = globalStatsigCache.get(cacheKey);
    if (cached) {
      this.statsigChunkUrl = cached.url;
      this.statsigModuleId = cached.moduleId;
      return cached;
    }

    if (this.statsigPromise) {
      return this.statsigPromise;
    }

    const statsigPromise = this.discoverStatsigChunkSource(cacheKey);
    this.statsigPromise = statsigPromise;

    try {
      return await statsigPromise;
    } finally {
      if (this.statsigPromise === statsigPromise) {
        this.statsigPromise = null;
      }
    }
  }

  async discoverStatsigChunkSource(cacheKey) {
    const page = await this.ensurePage();
    const urls = await page.evaluate(() =>
      Array.from(document.querySelectorAll("script"))
        .map((s) => s.src)
        .filter((src) => src.includes("/_next/static/chunks/"))
    );

    if (!urls.length) {
      throw new Error("No Next.js static chunks found on Grok page");
    }

    const chunkTexts = {};
    const fetchPromises = urls.map(async (url) => {
      try {
        const res = await fetch(url);
        if (res.ok) {
          chunkTexts[url] = await res.text();
        }
      } catch {}
    });

    await Promise.all(fetchPromises);

    let middlewareUrl = null;
    let statsigModuleId = null;

    for (const [url, text] of Object.entries(chunkTexts)) {
      const idx = text.indexOf("x-statsig-id");
      if (idx !== -1) {
        middlewareUrl = url;
        const legacyMatch = /\.([a-zA-Z_0-9]+)\((\d+)\)\.then\(/g.exec(text);
        if (legacyMatch) {
          statsigModuleId = legacyMatch[2];
          break;
        }

        const snippet = text.slice(Math.max(0, idx - 1500), idx);
        const matches = Array.from(snippet.matchAll(/\b[a-zA-Z_0-9\.]+\((\d{5,})\)/g));
        if (matches.length) {
          statsigModuleId = matches[matches.length - 1][1];
          break;
        }
      }
    }

    if (!middlewareUrl || !statsigModuleId) {
      throw new Error("Could not find statsig module ID in chunks");
    }

    let generatorChunkRelativePath = null;
    let targetInnerModuleId = null;

    for (const [url, text] of Object.entries(chunkTexts)) {
      const broadRegex = new RegExp(
        statsigModuleId +
          '[^}]+?"(static/chunks/[^"]+)"[^}]+?\\.then\\(\\(\\)\\s*=>\\s*[a-zA-Z_0-9]+\\(([^\\)]+)\\)\\)'
      );
      const match = broadRegex.exec(text);
      if (match) {
        generatorChunkRelativePath = match[1];
        targetInnerModuleId = match[2];
        break;
      }
    }

    if (!generatorChunkRelativePath || !targetInnerModuleId) {
      throw new Error("Could not find dynamic import definition for statsig module");
    }

    const generatorUrl = `${this.config.grokBaseUrl}/_next/${generatorChunkRelativePath}`;

    let numericModuleId = Number(targetInnerModuleId);
    if (isNaN(numericModuleId)) {
      try {
        numericModuleId = Function(`return (${targetInnerModuleId})`)();
      } catch {
        throw new Error(`Could not parse targetInnerModuleId: ${targetInnerModuleId}`);
      }
    }

    this.statsigChunkUrl = generatorUrl;
    this.statsigModuleId = numericModuleId;

    const discovered = {
      url: this.statsigChunkUrl,
      moduleId: this.statsigModuleId
    };
    globalStatsigCache.set(cacheKey, discovered);

    return discovered;
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

    await this.context.addInitScript(`
      window.__grokVerbose = ${!!this.config?.verbose};
      (${installGrokBridgePageHelpers.toString()})();
    `);

    this.bindingsInstalled = true;
  }

  async ensurePage() {
    if (this.page && !this.page.isClosed()) {
      const pageUrl = typeof this.page.url === "function" ? this.page.url() : "";
      if (
        this.validatedPage === this.page &&
        this.validatedPageUrl === pageUrl
      ) {
        return this.page;
      }

      try {
        await this.validatePage(this.page);
        this.validatedPage = this.page;
        this.validatedPageUrl = pageUrl;
        return this.page;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRecoverableContextError(msg)) {
          return this.recreateContext();
        }
        this.page = null;
      }
    }

    if (this.pagePromise) {
      return this.pagePromise;
    }

    const pagePromise = (async () => {
      if (!this.context) {
        await this.init();
      }

      let page;
      try {
        page = await this.context.newPage();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRecoverableContextError(msg)) {
          return this.recreateContext();
        }
        throw err;
      }

      page.on("console", (msg) => {
        if (this.config?.verbose) {
          console.log(`[BROWSER CONSOLE] [${msg.type()}] ${msg.text()}`);
        }
      });
      this.page = page;
      this.validatedPage = null;
      this.validatedPageUrl = null;
      page.on("close", () => {
        if (this.page === page) {
          this.page = null;
          this.pageUserAgent = null;
          this.validatedPage = null;
          this.validatedPageUrl = null;
        }
      });
      page.on("framenavigated", (frame) => {
        const mainFrame = typeof page.mainFrame === "function" ? page.mainFrame() : null;
        if (this.page === page && (!mainFrame || frame === mainFrame)) {
          this.validatedPage = null;
          this.validatedPageUrl = null;
        }
      });

      try {
        const response = await page.goto(this.config.grokBaseUrl, {
          waitUntil: "domcontentloaded"
        });
        try {
          const networkIdleTimeout = this.config.browserNetworkIdleTimeoutMs ?? 1000;
          await page.waitForLoadState("networkidle", { timeout: networkIdleTimeout });
        } catch (e) {}
        try {
          const pageLoadDelay = this.config.browserPageLoadDelayMs ?? 1000;
          await page.waitForTimeout(pageLoadDelay);
        } catch (e) {}
        await this.validatePage(page, response);
        this.validatedPage = page;
        this.validatedPageUrl = typeof page.url === "function" ? page.url() : "";

        try {
          this.pageUserAgent = await page.evaluate(() => navigator.userAgent);
        } catch {
          this.pageUserAgent = null;
        }

        return page;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRecoverableContextError(msg)) {
          return this.recreateContext();
        }
        throw err;
      }
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
    this.validatedPage = null;
    this.validatedPageUrl = null;
    try {
      return await this.ensurePage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRecoverableContextError(message)) {
        return this.recreateContext();
      }
      throw error;
    }
  }

  async recreateContext() {
    const context = this.context;
    this.resetContextState();
    await context?.close().catch(() => {});
    await this.init();
    return this.ensurePage();
  }

  async dismissModals(page) {
    try {
      const result = await page.evaluate(() => {
        const bodyText = document.body ? (document.body.innerText || "") : "";
        const hasToS = bodyText.includes("Terms of Service") || 
                      bodyText.includes("Acceptable Use Policy") || 
                      bodyText.includes("Terms of Use") ||
                      bodyText.includes("privacy policy") ||
                      bodyText.includes("cookie-consent") ||
                      bodyText.includes("updating our Terms") ||
                      bodyText.includes("Updates to our Terms");
                      
        if (!hasToS) {
          return { clicked: false, reason: "No ToS/Cookie text found" };
        }
        
        const candidates = Array.from(document.querySelectorAll('button, div[role="button"], span, a, [class*="button"], [id*="button"]'));
        const targets = ["got it", "accept", "agree", "i agree", "allow", "close", "gotit"];
        
        for (const el of candidates) {
          const text = (el.innerText || el.textContent || "").trim().toLowerCase();
          if (targets.includes(text)) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              el.click();
              return { clicked: true, text: text, elementClass: el.className };
            }
          }
        }
        
        return { clicked: false, reason: "No matching button found among candidates" };
      });
      
      if (result.clicked) {
        console.warn(`[BrowserSession] Dismissed modal by clicking "${result.text}" button.`);
        await page.waitForTimeout(2000);
      }
    } catch (error) {
      // Ignore errors during evaluation
    }
  }

  async validatePage(page, response = null) {
    const expectedOrigin = getOrigin(this.config.grokBaseUrl);
    const pageUrl = typeof page.url === "function" ? page.url() : "";
    const pageOrigin = getOrigin(pageUrl);

    if (expectedOrigin && pageOrigin && pageOrigin === expectedOrigin) {
      await this.dismissModals(page);

      let pagePathname = "";
      try {
        pagePathname = new URL(pageUrl).pathname.toLowerCase();
      } catch {}

      if (
        pagePathname === "/login" ||
        pagePathname === "/signin" ||
        pagePathname === "/sign-in" ||
        pagePathname === "/register" ||
        pagePathname === "/signup"
      ) {
        throw createSessionBlockedError(`redirected to login page (${pagePathname})`);
      }
    }

    const readPageSnapshot = () =>
      page.evaluate(() => ({
        title: document.title || "",
        text: document.body?.innerText?.slice(0, 1000) || ""
      })).catch(() => ({ title: "", text: "" }));

    if (expectedOrigin && pageOrigin && pageOrigin !== expectedOrigin) {
      const pageSnapshot = await readPageSnapshot();
      const title = pageSnapshot.title || "";
      const text = pageSnapshot.text || "";

      if (isCloudflareBlockText(`${title}\n${text}`)) {
        throw createSessionBlockedError(
          `Cloudflare block page at ${pageOrigin}`
        );
      }

      throw createSessionBlockedError(
        `redirected from ${expectedOrigin} to ${pageOrigin}`
      );
    }

    const status = getResponseStatus(response);
    if (status === 403 || status === 429 || status === 503) {
      const pageSnapshot = await readPageSnapshot();

      if (isCloudflareBlockText(`${pageSnapshot.title}\n${pageSnapshot.text}`)) {
        throw createSessionBlockedError(
          `Cloudflare returned HTTP ${status}`
        );
      }
    }

    if (response) {
      const pageSnapshot = await readPageSnapshot();
      if (isCloudflareBlockText(`${pageSnapshot.title}\n${pageSnapshot.text}`)) {
        throw createSessionBlockedError("Cloudflare block page");
      }
    }
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
    const { url: statsigChunkUrl, moduleId: statsigModuleId } = await this.loadStatsigChunkSource();

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
      statsigChunkUrl,
      statsigModuleId,
      streamBatchMaxChars: this.config.browserStreamBatchMaxChars,
      streamBatchDelayMs: this.config.browserStreamBatchDelayMs
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
      if (isRecoverableContextError(message)) {
        meta = null;
        setTextBufferLimit(
          textBuffer,
          onChunk ? 0 : Number.POSITIVE_INFINITY
        );
        clearTextBuffer(textBuffer);
        const page = await this.recreateContext();
        await run(page);
      } else if (isRecoverablePageError(message)) {
        meta = null;
        setTextBufferLimit(
          textBuffer,
          onChunk ? 0 : Number.POSITIVE_INFINITY
        );
        clearTextBuffer(textBuffer);
        let page;
        try {
          page = await this.recreatePage();
        } catch (recreateErr) {
          const recMsg = recreateErr instanceof Error ? recreateErr.message : String(recreateErr);
          if (isRecoverableContextError(recMsg)) {
            page = await this.recreateContext();
          } else {
            throw recreateErr;
          }
        }
        await run(page);
      } else {
        if (message.toLowerCase().includes("failed to fetch")) {
          await this.validatePage(await this.ensurePage()).catch(() => {});
        }
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

    const requestContext = this.context?.request;
    if (requestContext && typeof requestContext.get === "function") {
      const response = await requestContext.get(url, {
        failOnStatusCode: false,
        headers: {
          referer: `${this.config.grokBaseUrl}/`
        }
      });
      const status = getResponseStatus(response);
      if (!status) {
        throw new Error("Asset fetch failed without a response");
      }

      if (status >= 400) {
        throw new Error(`Asset fetch failed with status ${status}`);
      }

      const headers = getResponseHeaders(response);
      const bytes = await getResponseBody(response);
      await response.dispose?.().catch(() => {});

      return {
        contentType:
          headers["content-type"] ||
          headers["Content-Type"] ||
          "application/octet-stream",
        bytes
      };
    }

    const page = await this.ensurePage();
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

      const bytes = await getResponseBody(response);
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
