import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import {
  BrowserSession,
  GROK_SESSION_BLOCKED_ERROR_CODE,
  GROK_REQUEST_TIMEOUT_ERROR_CODE,
  ERROR_RESPONSE_TEXT_LIMIT,
  STATSIG_CHUNK_STALE_MARKER,
  STATSIG_GENERATION_FAILED_MARKER,
  installGrokBridgePageHelpers,
  isRecoverableContextError
} from "../src/grok/browser-session.js";
import { HttpError } from "../src/lib/errors.js";

function createSession(evaluateRequest) {
  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com"
  });

  session.init = async () => {};
  session.loadStatsigChunkSource = async () => ({ url: "statsig", moduleId: 880932 });
  session.ensurePage = async () => ({});
  session.evaluateRequest = async (_page, payload) => evaluateRequest(session, payload);

  return session;
}

test("request buffers successful bodies when no streaming callback is provided", async () => {
  const session = createSession((instance, payload) => {
    const pending = instance.pending.get(payload.requestId);
    pending.onMeta({
      requestId: payload.requestId,
      status: 200,
      headers: {}
    });
    pending.onChunk('{"ok":');
    pending.onChunk('"yes"}');
    pending.resolve();
  });

  const response = await session.request({
    requestId: "req-1",
    url: "https://grok.com/rest/test"
  });

  assert.equal(response.meta?.status, 200);
  assert.equal(response.text, '{"ok":"yes"}');
});

test("request does not buffer successful streamed bodies in memory", async () => {
  const streamed = [];
  const session = createSession((instance, payload) => {
    const pending = instance.pending.get(payload.requestId);
    pending.onMeta({
      requestId: payload.requestId,
      status: 200,
      headers: {}
    });
    pending.onChunk("hello ");
    pending.onChunk("world");
    pending.resolve();
  });

  const response = await session.request({
    requestId: "req-2",
    url: "https://grok.com/rest/test",
    onChunk(chunk) {
      streamed.push(chunk);
    }
  });

  assert.deepEqual(streamed, ["hello ", "world"]);
  assert.equal(response.meta?.status, 200);
  assert.equal(response.text, "");
});

test("request caps buffered error bodies for streamed responses", async () => {
  const streamed = [];
  const chunk = "x".repeat(65536);
  const session = createSession((instance, payload) => {
    const pending = instance.pending.get(payload.requestId);
    pending.onMeta({
      requestId: payload.requestId,
      status: 500,
      headers: {}
    });
    pending.onChunk(chunk);
    pending.onChunk(chunk);
    pending.onChunk(chunk);
    pending.resolve();
  });

  const response = await session.request({
    requestId: "req-3",
    url: "https://grok.com/rest/test",
    onChunk(bodyChunk) {
      streamed.push(bodyChunk);
    }
  });

  assert.equal(streamed.length, 3);
  assert.equal(response.meta?.status, 500);
  assert.equal(response.text.length, ERROR_RESPONSE_TEXT_LIMIT);
  assert.equal(response.text, "x".repeat(ERROR_RESPONSE_TEXT_LIMIT));
});

test("request fails fast when headers never arrive, recreates the page, and retries once", async () => {
  let dispatchCount = 0;
  let metaCount = 0;

  const session = createSession(async (instance, payload) => {
    const pending = instance.pending.get(payload.requestId);
    if (dispatchCount === 0) {
      // First attempt: the fetch is dispatched but response headers never
      // arrive, so the TTFB deadline fires and the page is recreated.
      dispatchCount += 1;
      pending.onDispatched?.();
      return;
    }
    if (dispatchCount === 1) {
      // Retry on the recreated page: headers arrive promptly.
      dispatchCount += 1;
      pending.onMeta({ requestId: payload.requestId, status: 200, headers: {} });
      pending.onChunk("retry-ok");
      pending.resolve();
      return;
    }
    metaCount += 1;
    pending.onMeta({ requestId: payload.requestId, status: 200, headers: {} });
    pending.resolve();
  });

  let recreateCalls = 0;
  session.recreatePage = async () => {
    recreateCalls += 1;
    return {};
  };

  const config = { browserTtfbTimeoutMs: 5 };
  Object.assign(session.config, config);

  const response = await session.request({
    requestId: "req-ttfb",
    url: "https://grok.com/rest/test"
  });

  assert.equal(recreateCalls, 1);
  assert.equal(dispatchCount, 2);
  assert.equal(response.meta?.status, 200);
  assert.equal(response.text, "retry-ok");
});

test("request aborts page fetches that exceed the configured timeout", async () => {
  const session = createSession(() => new Promise(() => {}));
  session.config.browserRequestTimeoutMs = 10;
  let abortedRequestId = null;
  session.abortRequest = async (_page, requestId) => {
    abortedRequestId = requestId;
    return true;
  };

  await assert.rejects(
    session.request({
      requestId: "req-timeout",
      url: "https://grok.com/rest/test"
    }),
    (error) =>
      error?.status === 504 &&
      error?.details?.code === GROK_REQUEST_TIMEOUT_ERROR_CODE
  );

  assert.equal(abortedRequestId, "req-timeout");
  assert.equal(session.pending.has("req-timeout"), false);
});

test("warmed requests use one browser evaluation", async () => {
  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com"
  });
  let evaluateCalls = 0;
  const page = {
    isClosed() {
      return false;
    },
    url() {
      return "https://grok.com/";
    },
    async evaluate(_fn, payload) {
      evaluateCalls += 1;
      const pending = session.pending.get(payload.requestId);
      pending.onMeta({
        requestId: payload.requestId,
        status: 200,
        headers: {}
      });
      pending.onChunk("ok");
      pending.resolve();
    }
  };

  session.context = {};
  session.page = page;
  session.validatedPage = page;
  session.validatedPageUrl = page.url();
  session.statsigChunkUrl = "https://grok.com/statsig.js";
  session.statsigModuleId = 1;

  const response = await session.request({
    requestId: "req-warm-fast-path",
    url: "https://grok.com/rest/test"
  });

  assert.equal(response.text, "ok");
  assert.equal(evaluateCalls, 1);
});

test("request recreates the page when the Grok bridge helper is missing", async () => {
  const session = createSession((instance, payload) => {
    instance.attempts = (instance.attempts || 0) + 1;

    if (instance.attempts === 1) {
      throw new Error(
        "page.evaluate: TypeError: window.__grokBridgeFetch is not a function"
      );
    }

    const pending = instance.pending.get(payload.requestId);
    pending.onMeta({
      requestId: payload.requestId,
      status: 200,
      headers: {}
    });
    pending.onChunk("recovered");
    pending.resolve();
  });

  let recreateCount = 0;
  session.recreatePage = async () => {
    recreateCount += 1;
    return {};
  };

  const response = await session.request({
    requestId: "req-bridge-retry",
    url: "https://grok.com/rest/test"
  });

  assert.equal(recreateCount, 1);
  assert.equal(response.meta?.status, 200);
  assert.equal(response.text, "recovered");
});

test("request recreates the page when a Grok bridge binding is missing", async () => {
  const session = createSession((instance, payload) => {
    instance.attempts = (instance.attempts || 0) + 1;

    if (instance.attempts === 1) {
      throw new Error(
        "page.evaluate: TypeError: window.grokBridgeError is not a function"
      );
    }

    const pending = instance.pending.get(payload.requestId);
    pending.onMeta({
      requestId: payload.requestId,
      status: 200,
      headers: {}
    });
    pending.onChunk("recovered");
    pending.resolve();
  });

  let recreateCount = 0;
  session.recreatePage = async () => {
    recreateCount += 1;
    return {};
  };

  const response = await session.request({
    requestId: "req-binding-retry",
    url: "https://grok.com/rest/test"
  });

  assert.equal(recreateCount, 1);
  assert.equal(response.meta?.status, 200);
  assert.equal(response.text, "recovered");
});

test("request recreates the page when Playwright reports a closed page target", async () => {
  const session = createSession((instance, payload) => {
    instance.attempts = (instance.attempts || 0) + 1;

    if (instance.attempts === 1) {
      throw new Error(
        "page.evaluate: Target page, context or browser has been closed"
      );
    }

    const pending = instance.pending.get(payload.requestId);
    pending.onMeta({
      requestId: payload.requestId,
      status: 200,
      headers: {}
    });
    pending.onChunk("recovered");
    pending.resolve();
  });

  let recreateCount = 0;
  session.recreatePage = async () => {
    recreateCount += 1;
    return {};
  };

  const response = await session.request({
    requestId: "req-target-closed-retry",
    url: "https://grok.com/rest/test"
  });

  assert.equal(recreateCount, 1);
  assert.equal(response.meta?.status, 200);
  assert.equal(response.text, "recovered");
});

test("request relaunches the browser context when Chromium cannot create a new tab", async () => {
  const recoveredPage = createMockPage("Mozilla/5.0 Recovered");
  let closedBrokenContext = false;
  let initCalls = 0;

  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com"
  });

  session.context = {
    async newPage() {
      throw new Error(
        "browserContext.newPage: Protocol error (Target.createTarget): Failed to open a new tab"
      );
    },
    async close() {
      closedBrokenContext = true;
    }
  };
  session.init = async () => {
    initCalls += 1;
    if (!session.context) {
      session.context = {
        async newPage() {
          return recoveredPage;
        },
        async close() {}
      };
    }
  };
  session.loadStatsigChunkSource = async () => ({ url: "statsig", moduleId: 880932 });
  session.evaluateRequest = async (_page, payload) => {
    const pending = session.pending.get(payload.requestId);
    pending.onMeta({
      requestId: payload.requestId,
      status: 200,
      headers: {}
    });
    pending.onChunk("recovered");
    pending.resolve();
  };

  const response = await session.request({
    requestId: "req-context-retry",
    url: "https://grok.com/rest/test"
  });

  assert.equal(closedBrokenContext, true);
  assert.equal(initCalls, 2);
  assert.equal(session.page, recoveredPage);
  assert.equal(response.meta?.status, 200);
  assert.equal(response.text, "recovered");
});

test("request rediscovers the statsig chunk source when the cached source goes stale", async () => {
  let loadCalls = 0;
  const session = createSession((instance, payload) => {
    instance.attempts = (instance.attempts || 0) + 1;

    if (instance.attempts === 1) {
      throw new Error(
        `Error: ${STATSIG_CHUNK_STALE_MARKER}: Failed to load script: https://grok.com/_next/static/chunks/old.js\nStack: at window.__grokBridgeFetch`
      );
    }

    assert.equal(
      payload.statsigChunkUrl,
      "https://grok.com/_next/static/chunks/new.js"
    );
    assert.equal(payload.statsigModuleId, 222);

    const pending = instance.pending.get(payload.requestId);
    pending.onMeta({
      requestId: payload.requestId,
      status: 200,
      headers: {}
    });
    pending.onChunk("recovered");
    pending.resolve();
  });

  session.loadStatsigChunkSource = async () => {
    loadCalls += 1;
    if (loadCalls === 1) {
      session.statsigChunkUrl = "https://grok.com/_next/static/chunks/old.js";
      session.statsigModuleId = 111;
    } else {
      session.statsigChunkUrl = "https://grok.com/_next/static/chunks/new.js";
      session.statsigModuleId = 222;
    }
    return { url: session.statsigChunkUrl, moduleId: session.statsigModuleId };
  };

  const response = await session.request({
    requestId: "req-stale-statsig",
    url: "https://grok.com/rest/test"
  });

  assert.equal(loadCalls, 2);
  assert.equal(response.meta?.status, 200);
  assert.equal(response.text, "recovered");
});

test("request gives up on stale statsig chunks after one rediscovery", async () => {
  const session = createSession(() => {
    throw new Error(
      `Error: ${STATSIG_CHUNK_STALE_MARKER}: Failed to load script: https://grok.com/_next/static/chunks/old.js\nStack: at window.__grokBridgeFetch`
    );
  });

  let loadCalls = 0;
  session.loadStatsigChunkSource = async () => {
    loadCalls += 1;
    session.statsigChunkUrl = `https://grok.com/_next/static/chunks/${loadCalls}.js`;
    session.statsigModuleId = loadCalls;
    return { url: session.statsigChunkUrl, moduleId: session.statsigModuleId };
  };

  await assert.rejects(
    session.request({
      requestId: "req-stale-statsig-2",
      url: "https://grok.com/rest/test"
    }),
    (error) => error.message.includes(STATSIG_CHUNK_STALE_MARKER)
  );

  assert.equal(loadCalls, 2);
});

test("error binding preserves HttpError status and details", async () => {
  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com"
  });
  const bindings = new Map();
  session.context = {
    async exposeBinding(name, handler) {
      bindings.set(name, handler);
    },
    async addInitScript() {}
  };

  await session.installBindings();

  let rejectedError = null;
  session.pending.set("req-error-binding", {
    onMeta() {},
    onChunk() {},
    resolve() {},
    reject(error) {
      rejectedError = error;
    }
  });

  await bindings.get("__grokBridgeError")(null, {
    requestId: "req-error-binding",
    status: 429,
    message: "Grok is under heavy usage",
    details: { code: "rate_limit_exceeded" }
  });

  assert.ok(rejectedError instanceof HttpError);
  assert.equal(rejectedError.status, 429);
  assert.equal(rejectedError.details.code, "rate_limit_exceeded");
  assert.equal(session.pending.has("req-error-binding"), false);
});

test("error binding defaults to 502 without an upstream status", async () => {
  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com"
  });
  const bindings = new Map();
  session.context = {
    async exposeBinding(name, handler) {
      bindings.set(name, handler);
    },
    async addInitScript() {}
  };

  await session.installBindings();

  let rejectedError = null;
  session.pending.set("req-error-binding-2", {
    onMeta() {},
    onChunk() {},
    resolve() {},
    reject(error) {
      rejectedError = error;
    }
  });

  await bindings.get("grokBridgeError")(null, {
    requestId: "req-error-binding-2",
    message: "Something failed"
  });

  assert.ok(rejectedError instanceof HttpError);
  assert.equal(rejectedError.status, 502);
  assert.deepEqual(rejectedError.details, {});
});

test("ensurePage rejects a Grok session redirected to a Cloudflare block page", async () => {
  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com"
  });
  const page = {
    on() {},
    isClosed() {
      return false;
    },
    url() {
      return "https://accounts.x.ai/check-login?redirect=grok-com";
    },
    async goto() {
      return createMockResponse({
        status: 403,
        headers: {
          "content-type": "text/html"
        }
      });
    },
    async evaluate() {
      return {
        title: "Attention Required! | Cloudflare",
        text: "Sorry, you have been blocked"
      };
    },
    async close() {}
  };

  session.context = {
    async newPage() {
      return page;
    }
  };

  await assert.rejects(
    session.ensurePage(),
    (error) =>
      error?.details?.code === GROK_SESSION_BLOCKED_ERROR_CODE &&
      /Cloudflare/.test(error.message)
  );
});

test("installBindings exposes both canonical and legacy Grok bridge names", async () => {
  const exposed = [];
  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com"
  });

  session.context = {
    async exposeBinding(name) {
      exposed.push(name);
    },
    async addInitScript() {}
  };

  await session.installBindings();

  assert.deepEqual(exposed, [
    "__grokBridgeDispatched",
    "grokBridgeDispatched",
    "__grokBridgeMeta",
    "grokBridgeMeta",
    "__grokBridgeChunk",
    "grokBridgeChunk",
    "__grokBridgeDone",
    "grokBridgeDone",
    "__grokBridgeError",
    "grokBridgeError",
    "__grokBridgeStatsigMeta",
    "grokBridgeStatsigMeta"
  ]);
});

test("page bridge batches fast response chunks and installs idempotently", async () => {
  const originalGlobals = new Map();
  const globalNames = ["window", "document", "location", "MutationObserver", "fetch"];
  for (const name of globalNames) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }

  const chunkPayloads = [];
  const metadataPayloads = [];
  const donePayloads = [];
  const errorPayloads = [];
  const documentSelectors = [];
  const initialScanSelectors = [];
  let observerCount = 0;
  const documentElement = {
    nodeType: 1,
    matches() {
      return false;
    },
    querySelectorAll(selector) {
      initialScanSelectors.push(selector);
      return [];
    }
  };
  const document = {
    documentElement,
    querySelectorAll(selector) {
      documentSelectors.push(selector);
      return [];
    },
    querySelector() {
      return null;
    },
    getElementsByClassName() {
      return [];
    }
  };
  const window = {
    __grokStatsigGen: async () => "statsig-id",
    async __grokBridgeMeta(payload) {
      metadataPayloads.push(payload);
    },
    async __grokBridgeChunk(payload) {
      chunkPayloads.push(payload);
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    async __grokBridgeDone(payload) {
      donePayloads.push(payload);
    },
    async __grokBridgeError(payload) {
      errorPayloads.push(payload);
    }
  };
  const encodedChunk = new TextEncoder().encode("x");
  let readCount = 0;

  Object.defineProperties(globalThis, {
    window: { configurable: true, writable: true, value: window },
    document: { configurable: true, writable: true, value: document },
    location: {
      configurable: true,
      writable: true,
      value: { origin: "https://grok.com" }
    },
    MutationObserver: {
      configurable: true,
      writable: true,
      value: class {
        constructor() {
          observerCount += 1;
        }

        observe() {}
      }
    },
    fetch: {
      configurable: true,
      writable: true,
      value: async (url, options) => {
        if (url.endsWith("/abort")) {
          return new Promise((_resolve, reject) => {
            const rejectAborted = () =>
              reject(new DOMException("The operation was aborted", "AbortError"));
            if (options.signal.aborted) {
              rejectAborted();
              return;
            }
            options.signal.addEventListener("abort", rejectAborted, { once: true });
          });
        }

        return {
          status: 200,
          headers: {
            forEach(callback) {
              callback("application/x-ndjson", "content-type");
            }
          },
          body: {
            getReader() {
              return {
                async read() {
                  if (readCount >= 1024) {
                    return { done: true, value: undefined };
                  }

                  readCount += 1;
                  return { done: false, value: encodedChunk };
                }
              };
            }
          }
        };
      }
    }
  });

  try {
    installGrokBridgePageHelpers();
    const installedQuerySelectorAll = document.querySelectorAll;
    installGrokBridgePageHelpers();

    assert.equal(observerCount, 1);
    assert.equal(document.querySelectorAll, installedQuerySelectorAll);
    assert.deepEqual(initialScanSelectors, [
      'path, svg, meta[name^=gr], [class*="r-6k"], [id^="loading-x-anim-"]'
    ]);
    assert.equal(documentSelectors.includes("*"), false);

    await window.__grokBridgeFetch({
      requestId: "req-batched-stream",
      url: "https://grok.com/rest/test",
      method: "GET",
      headers: {},
      statsigChunkUrl: "https://grok.com/statsig.js",
      statsigModuleId: 1,
      streamBatchMaxChars: 128,
      streamBatchDelayMs: 1000
    });

    const abortedFetch = window.__grokBridgeFetch({
      requestId: "req-aborted-stream",
      url: "https://grok.com/abort",
      method: "GET",
      headers: {},
      statsigChunkUrl: "https://grok.com/statsig.js",
      statsigModuleId: 1
    });
    assert.equal(window.__grokBridgeAbortRequest("req-aborted-stream"), true);
    await abortedFetch;
    assert.equal(window.__grokBridgeAbortRequest("req-aborted-stream"), false);
  } finally {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
  }

  assert.equal(metadataPayloads.length, 1);
  assert.equal(donePayloads.length, 1);
  assert.equal(errorPayloads.length, 1);
  assert.match(errorPayloads[0].message, /AbortError/);
  assert.equal(chunkPayloads.length, 8);
  assert.equal(chunkPayloads.map((payload) => payload.chunk).join(""), "x".repeat(1024));
});

function installBridgeTestGlobals({ statsigGen, fetchImpl }) {
  const originalGlobals = new Map();
  const globalNames = [
    "window",
    "document",
    "location",
    "MutationObserver",
    "fetch"
  ];
  for (const name of globalNames) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }

  const errorPayloads = [];
  const fetched = [];
  const observers = [];
  function createMockElement(tag = "div") {
    const children = [];
    const attributes = new Map();
    const element = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      childNodes: children,
      className: "",
      id: "",
      style: {},
      setAttribute(name, val) {
        attributes.set(name, String(val));
        if (name === "class") element.className = String(val);
        if (name === "id") element.id = String(val);
      },
      getAttribute(name) {
        return attributes.get(name) || null;
      },
      hasAttribute(name) {
        return attributes.has(name);
      },
      appendChild(child) {
        children.push(child);
        child.parentElement = element;
        return child;
      },
      matches(selector) {
        if (!selector) return false;
        for (const part of selector.split(",")) {
          const sel = part.trim();
          if (!sel) continue;
          if (sel.startsWith("#") && element.id === sel.slice(1)) return true;
          if (sel.startsWith(".") && element.className.includes(sel.slice(1))) return true;
          if (sel.startsWith('[id="') && element.id === sel.slice(5, -2)) return true;
          if (sel.toLowerCase() === tag.toLowerCase()) return true;
        }
        return false;
      },
      querySelectorAll(selector) {
        const matches = [];
        for (const child of children) {
          if (child.matches && child.matches(selector)) matches.push(child);
          if (child.querySelectorAll) matches.push(...child.querySelectorAll(selector));
        }
        return matches;
      },
      cloneNode(deep = true) {
        const clone = createMockElement(tag);
        clone.className = element.className;
        clone.id = element.id;
        for (const [k, v] of attributes.entries()) {
          clone.setAttribute(k, v);
        }
        if (deep) {
          for (const child of children) {
            clone.appendChild(child.cloneNode(true));
          }
        }
        return clone;
      },
      isEqualNode(other) {
        if (
          !other ||
          other.tagName !== element.tagName ||
          other.id !== element.id ||
          other.className !== element.className
        ) {
          return false;
        }
        return true;
      }
    };
    return element;
  }

  const documentElement = createMockElement("html");
  const body = createMockElement("body");
  documentElement.appendChild(body);

  const document = {
    documentElement,
    body,
    createElement(tag) {
      return createMockElement(tag);
    },
    createElementNS(_ns, tag) {
      return createMockElement(tag);
    },
    getElementById(id) {
      return documentElement.querySelectorAll(`[id="${id}"]`)[0] || null;
    },
    querySelectorAll(selector) {
      return documentElement.querySelectorAll(selector);
    },
    querySelector(selector) {
      return documentElement.querySelectorAll(selector)[0] || null;
    },
    getElementsByClassName(className) {
      return documentElement.querySelectorAll("." + className);
    }
  };
  const window = {
    __grokStatsigGen: statsigGen,
    async __grokBridgeMeta() {},
    async __grokBridgeChunk() {},
    async __grokBridgeDone() {},
    async __grokBridgeError(payload) {
      errorPayloads.push(payload);
    }
  };

  Object.defineProperties(globalThis, {
    window: { configurable: true, writable: true, value: window },
    document: { configurable: true, writable: true, value: document },
    location: {
      configurable: true,
      writable: true,
      value: { origin: "https://grok.com" }
    },
    MutationObserver: {
      configurable: true,
      writable: true,
      value: class {
        constructor(callback) {
          this.callback = callback;
          observers.push(this);
        }
        observe() {}
      }
    },
    fetch: {
      configurable: true,
      writable: true,
      value: async (url, options) => {
        fetched.push({ url, statsigId: options.headers.get("x-statsig-id") });
        return {
          status: 200,
          headers: {
            forEach(callback) {
              callback("application/x-ndjson", "content-type");
            }
          },
          body: {
            getReader() {
              return {
                async read() {
                  return { done: true, value: undefined };
                }
              };
            }
          }
        };
      }
    }
  });

  return {
    window,
    errorPayloads,
    fetched,
    observers,
    restore() {
      for (const [name, descriptor] of originalGlobals) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete globalThis[name];
        }
      }
    }
  };
}

const STATSIG_FETCH_PAYLOAD = {
  requestId: "req-statsig",
  url: "https://grok.com/rest/app-chat/conversations/new",
  method: "POST",
  headers: {},
  statsigChunkUrl: "https://grok.com/statsig.js",
  statsigModuleId: 1,
  statsigMaxAttempts: 10,
  statsigRetryDelayMs: 5
};

test("page bridge retries statsig generation until the Grok app is ready", async () => {
  let statsigCalls = 0;
  const env = installBridgeTestGlobals({
    statsigGen: async () => {
      statsigCalls += 1;
      if (statsigCalls < 3) {
        throw new TypeError(
          "Cannot read properties of undefined (reading 'childNodes')"
        );
      }
      return "retried-statsig-id";
    }
  });

  try {
    installGrokBridgePageHelpers();
    await env.window.__grokBridgeFetch(STATSIG_FETCH_PAYLOAD);
  } finally {
    env.restore();
  }

  assert.equal(statsigCalls, 3);
  assert.equal(env.fetched.length, 1);
  assert.equal(env.fetched[0].statsigId, "retried-statsig-id");
  assert.equal(env.errorPayloads.length, 0);
});

test("page bridge never sends requests without a valid statsig id", async () => {
  const env = installBridgeTestGlobals({
    statsigGen: async () => {
      throw new TypeError(
        "Cannot read properties of undefined (reading 'childNodes')"
      );
    }
  });

  try {
    installGrokBridgePageHelpers();
    await env.window.__grokBridgeFetch(STATSIG_FETCH_PAYLOAD);
  } finally {
    env.restore();
  }

  assert.equal(env.fetched.length, 0);
  assert.equal(env.errorPayloads.length, 1);
  assert.match(env.errorPayloads[0].message, new RegExp(STATSIG_GENERATION_FAILED_MARKER));
});

test("page bridge marks stale statsig chunk sources for rediscovery", async () => {
  const env = installBridgeTestGlobals({
    statsigGen: async () => {
      throw new Error(
        "Script loaded but module 1645000 was not intercepted"
      );
    }
  });

  try {
    installGrokBridgePageHelpers();
    await env.window.__grokBridgeFetch(STATSIG_FETCH_PAYLOAD);
  } finally {
    env.restore();
  }

  assert.equal(env.fetched.length, 0);
  assert.equal(env.errorPayloads.length, 1);
  assert.match(env.errorPayloads[0].message, new RegExp(STATSIG_CHUNK_STALE_MARKER));
});

test("page bridge bails out quickly when the page redirected to login", async () => {
  const originalLocation = globalThis.location;
  let statsigCalls = 0;
  const env = installBridgeTestGlobals({
    statsigGen: async () => {
      statsigCalls += 1;
      throw new TypeError(
        "Cannot read properties of undefined (reading 'childNodes')"
      );
    }
  });

  try {
    globalThis.location = { origin: "https://grok.com", pathname: "/login" };
    installGrokBridgePageHelpers();
    await env.window.__grokBridgeFetch({
      ...STATSIG_FETCH_PAYLOAD,
      statsigMaxAttempts: 10,
      statsigRetryDelayMs: 5
    });
  } finally {
    globalThis.location = originalLocation;
    env.restore();
  }

  assert.equal(env.fetched.length, 0);
  assert.equal(env.errorPayloads.length, 1);
  assert.match(env.errorPayloads[0].message, /redirected to login page/);
  assert.ok(
    statsigCalls < 10,
    `expected early bail, generator was called ${statsigCalls} times`
  );
});

test("page bridge bails out quickly when generation fails identically", async () => {
  // A deterministic failure (e.g. a stale middleware build querying a DOM
  // node the new build no longer provides) repeats the exact same error on
  // every attempt. Retrying it burns the whole multi-minute budget; the
  // bridge must surface it fast so the server-side rediscovery can take
  // over.
  let statsigCalls = 0;
  const env = installBridgeTestGlobals({
    statsigGen: async () => {
      statsigCalls += 1;
      throw new TypeError(
        "Cannot read properties of undefined (reading 'childNodes')"
      );
    }
  });

  try {
    installGrokBridgePageHelpers();
    await env.window.__grokBridgeFetch({
      ...STATSIG_FETCH_PAYLOAD,
      statsigMaxAttempts: 600,
      statsigRetryDelayMs: 1,
      statsigIdenticalBailMs: 30
    });
  } finally {
    env.restore();
  }

  assert.ok(
    statsigCalls < 100,
    `expected early bail, generator was called ${statsigCalls} times`
  );
  assert.equal(env.fetched.length, 0);
  assert.equal(env.errorPayloads.length, 1);
  assert.match(env.errorPayloads[0].message, new RegExp(STATSIG_GENERATION_FAILED_MARKER));
});

test("page bridge still waits out transient identical failures below the bail window", async () => {
  // Retrying a few identical failures is the point of the retry loop (the
  // app is still mounting); the bail must only fire after the streak has
  // run for the configured window.
  let statsigCalls = 0;
  const env = installBridgeTestGlobals({
    statsigGen: async () => {
      statsigCalls += 1;
      if (statsigCalls < 4) {
        throw new TypeError(
          "Cannot read properties of undefined (reading 'childNodes')"
        );
      }
      return "waited-out-statsig-id";
    }
  });

  try {
    installGrokBridgePageHelpers();
    await env.window.__grokBridgeFetch({
      ...STATSIG_FETCH_PAYLOAD,
      statsigMaxAttempts: 10,
      statsigRetryDelayMs: 1,
      statsigIdenticalBailMs: 5000
    });
  } finally {
    env.restore();
  }

  assert.equal(statsigCalls, 4);
  assert.equal(env.fetched.length, 1);
  assert.equal(env.fetched[0].statsigId, "waited-out-statsig-id");
  assert.equal(env.errorPayloads.length, 0);
});

test("page bridge does not bail across a mixed error streak", async () => {
  let statsigCalls = 0;
  const env = installBridgeTestGlobals({
    statsigGen: async () => {
      statsigCalls += 1;
      if (statsigCalls % 2 === 1) {
        throw new Error("first kind of failure");
      }
      throw new Error("second kind of failure");
    }
  });

  try {
    installGrokBridgePageHelpers();
    await env.window.__grokBridgeFetch({
      ...STATSIG_FETCH_PAYLOAD,
      statsigMaxAttempts: 600,
      statsigRetryDelayMs: 1,
      statsigIdenticalBailMs: 20
    });
  } finally {
    env.restore();
  }

  // Alternating messages never form an identical streak, so the budget is
  // exhausted instead of bailing early.
  assert.ok(statsigCalls >= 500, `expected full budget, got ${statsigCalls}`);
  assert.equal(env.fetched.length, 0);
  assert.equal(env.errorPayloads.length, 1);
  assert.match(env.errorPayloads[0].message, new RegExp(STATSIG_GENERATION_FAILED_MARKER));
});

test("request rediscovers the statsig chunk source when generation fails", async () => {
  // A Grok deploy makes the cached middleware chunk stale while it still
  // loads fine, so the chunk-stale branch never fires: generation crashes
  // instead. The retry must drop the cached source, rediscover from the
  // live page, and retry with the fresh middleware rather than recreating
  // the page with the same stale chunk.
  const attemptedPayloads = [];
  const session = createSession((instance, payload) => {
    attemptedPayloads.push({
      url: payload.statsigChunkUrl,
      moduleId: payload.statsigModuleId
    });
    instance.attempts = (instance.attempts || 0) + 1;

    if (instance.attempts === 1) {
      throw new Error(
        `page.evaluate: Error: ${STATSIG_GENERATION_FAILED_MARKER}: Grok statsig id generation failed: Cannot read properties of undefined (reading 'childNodes')`
      );
    }

    const pending = instance.pending.get(payload.requestId);
    pending.onMeta({
      requestId: payload.requestId,
      status: 200,
      headers: {}
    });
    pending.onChunk("recovered-after-rediscovery");
    pending.resolve();
  });

  let rediscoverCalls = 0;
  let recreateCount = 0;
  session.statsigChunkUrl = "https://grok.com/old-chunk.js";
  session.statsigModuleId = 111;
  session.loadStatsigChunkSource = async () => {
    rediscoverCalls += 1;
    if (!session.statsigChunkUrl) {
      session.statsigChunkUrl = "https://grok.com/new-chunk.js";
      session.statsigModuleId = 222;
    }
    return { url: session.statsigChunkUrl, moduleId: session.statsigModuleId };
  };
  session.recreatePage = async () => {
    recreateCount += 1;
    return {};
  };

  const response = await session.request({
    requestId: "req-statsig-rediscover",
    url: "https://grok.com/rest/test"
  });

  assert.equal(rediscoverCalls, 2, "rediscovery runs at request start and again after the failure");
  assert.equal(recreateCount, 1);
  assert.equal(response.meta?.status, 200);
  assert.equal(response.text, "recovered-after-rediscovery");
  assert.equal(attemptedPayloads[0].url, "https://grok.com/old-chunk.js");
  assert.equal(attemptedPayloads[1].url, "https://grok.com/new-chunk.js");
  assert.equal(attemptedPayloads[1].moduleId, 222);
});

test("request retries with the previous chunk source when rediscovery fails", async () => {
  const session = createSession((instance, payload) => {
    instance.attempts = (instance.attempts || 0) + 1;

    if (instance.attempts === 1) {
      throw new Error(
        `page.evaluate: Error: ${STATSIG_GENERATION_FAILED_MARKER}: Grok statsig id generation failed: Cannot read properties of undefined (reading 'childNodes')`
      );
    }

    const pending = instance.pending.get(payload.requestId);
    pending.onMeta({
      requestId: payload.requestId,
      status: 200,
      headers: {}
    });
    pending.onChunk("recovered-with-previous-source");
    pending.resolve();
  });

  session.statsigChunkUrl = "https://grok.com/previous-chunk.js";
  session.statsigModuleId = 333;
  let rediscoverCalls = 0;
  session.loadStatsigChunkSource = async () => {
    rediscoverCalls += 1;
    // The first call (request start) succeeds; rediscovery after the
    // failure is wedged and throws.
    if (rediscoverCalls > 1) {
      throw new Error("Could not find statsig module ID in chunks");
    }
    return { url: session.statsigChunkUrl, moduleId: session.statsigModuleId };
  };
  let recreateCount = 0;
  session.recreatePage = async () => {
    recreateCount += 1;
    return {};
  };

  const response = await session.request({
    requestId: "req-statsig-rediscover-fail",
    url: "https://grok.com/rest/test"
  });

  assert.equal(rediscoverCalls, 2);
  assert.equal(recreateCount, 1);
  assert.equal(response.meta?.status, 200);
  assert.equal(response.text, "recovered-with-previous-source");
  assert.equal(session.statsigChunkUrl, "https://grok.com/previous-chunk.js");
});

test("request recreates the page when statsig generation fails on the first attempt", async () => {
  const session = createSession((instance, payload) => {
    instance.attempts = (instance.attempts || 0) + 1;

    if (instance.attempts === 1) {
      throw new Error(
        `page.evaluate: Error: ${STATSIG_GENERATION_FAILED_MARKER}: Grok statsig id generation failed: Cannot read properties of undefined (reading 'childNodes')`
      );
    }

    const pending = instance.pending.get(payload.requestId);
    pending.onMeta({
      requestId: payload.requestId,
      status: 200,
      headers: {}
    });
    pending.onChunk("recovered-after-statsig-failure");
    pending.resolve();
  });

  let recreateCount = 0;
  session.recreatePage = async () => {
    recreateCount += 1;
    return {};
  };

  const response = await session.request({
    requestId: "req-statsig-failed-retry",
    url: "https://grok.com/rest/test"
  });

  assert.equal(recreateCount, 1);
  assert.equal(response.meta?.status, 200);
  assert.equal(response.text, "recovered-after-statsig-failure");
});

test("page bridge self-heals botox elements from window.__next_f when DOM is empty", async () => {
  const env = installBridgeTestGlobals({
    statsigGen: async () => {
      const els = globalThis.document.querySelectorAll(".r-3aha00");
      if (!els || els.length < 4) {
        throw new TypeError("Cannot read properties of undefined (reading 'childNodes')");
      }
      return "botox-healed-statsig-id";
    }
  });

  env.window.__next_f = [
    [
      1,
      '{"curves":[[{"color":[1,2,3,4,5,6],"deg":90,"bezier":[10,20,30,40]}],[{"color":[1,2,3,4,5,6],"deg":90,"bezier":[10,20,30,40]}],[{"color":[1,2,3,4,5,6],"deg":90,"bezier":[10,20,30,40]}],[{"color":[1,2,3,4,5,6],"deg":90,"bezier":[10,20,30,40]}]],"css_class":"r-3aha00"}'
    ]
  ];

  try {
    installGrokBridgePageHelpers();
    await env.window.__grokBridgeFetch(STATSIG_FETCH_PAYLOAD);
  } finally {
    env.restore();
  }

  assert.equal(env.fetched.length, 1);
  assert.equal(env.fetched[0].statsigId, "botox-healed-statsig-id");
  assert.equal(env.errorPayloads.length, 0);
});

test("page bridge bounds the saved-element clone cache instead of growing forever", async () => {
  const env = installBridgeTestGlobals({
    statsigGen: async () => "bounded-statsig-id"
  });
  const consoleLogs = [];
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  console.log = (...args) => {
    consoleLogs.push(args.map(String).join(" "));
  };
  console.error = () => {};

  try {
    installGrokBridgePageHelpers();
    env.window.__grokVerbose = true;

    assert.equal(env.observers.length, 1);
    const observer = env.observers[0];

    // Flood the observer with far more unique statsig-candidate nodes than
    // the clone-cache bound: each one clones because its class/id differs.
    const addedNodes = [];
    for (let i = 0; i < 1100; i += 1) {
      const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
      el.setAttribute("class", `r-bounds-${i}`);
      el.setAttribute("d", `M${i},0 L${i},10`);
      addedNodes.push(el);
    }
    observer.callback([{ addedNodes, type: "childList" }]);

    await env.window.__grokBridgeFetch(STATSIG_FETCH_PAYLOAD);

    const sizeLine = consoleLogs.find((line) =>
      line.includes("statsig generator cache size")
    );
    assert.ok(
      sizeLine,
      `expected a cache-size log line, got: ${consoleLogs.join("\n") || "(none)"}`
    );
    const size = Number(/cache size: (\d+)/.exec(sizeLine)?.[1]);
    assert.ok(Number.isInteger(size), `unparseable cache size line: ${sizeLine}`);
    assert.ok(size <= 1024, `saved-element cache exceeded its bound: ${size}`);

    // The recent clones must still be reachable through the selector
    // fallback after the FIFO window pruned the oldest entries.
    assert.ok(
      document.querySelector(".r-bounds-1099"),
      "recently cached elements must stay queryable after pruning"
    );
    assert.equal(env.fetched.length, 1);
    assert.equal(env.fetched[0].statsigId, "bounded-statsig-id");
    assert.equal(env.errorPayloads.length, 0);
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    env.restore();
  }
});

function createMockResponse({
  status = 200,
  headers = {
    "content-type": "text/plain"
  },
  body = Buffer.from("asset"),
  isNavigationRequest = true,
  resourceType = "document",
  frame = null
} = {}) {
  const normalizedBody = Buffer.isBuffer(body) ? body : Buffer.from(body);

  return {
    status() {
      return status;
    },
    headers() {
      return headers;
    },
    async body() {
      return normalizedBody;
    },
    request() {
      return {
        isNavigationRequest() {
          return isNavigationRequest;
        },
        resourceType() {
          return resourceType;
        }
      };
    },
    frame() {
      return frame;
    }
  };
}

function createMockPage(userAgent, options = {}) {
  let closed = false;
  const listeners = new Map();
  let evaluateCount = 0;
  const mainFrame = { id: Symbol("main-frame") };
  const gotoImpl = options.goto ?? (async () => {});
  const waitForLoadStateImpl = options.waitForLoadState ?? (async () => {});

  const emit = (event, payload) => {
    for (const handler of listeners.get(event) ?? []) {
      handler(payload);
    }
  };

  return {
    async evaluate() {
      evaluateCount += 1;
      return userAgent;
    },
    async goto(url, gotoOptions) {
      return gotoImpl({
        url,
        options: gotoOptions,
        emit,
        mainFrame
      });
    },
    async waitForLoadState(state, waitOptions) {
      return waitForLoadStateImpl({
        state,
        options: waitOptions,
        emit,
        mainFrame
      });
    },
    on(event, handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
    mainFrame() {
      return mainFrame;
    },
    isClosed() {
      return closed;
    },
    async close() {
      closed = true;
      emit("close");
    },
    get evaluateCount() {
      return evaluateCount;
    },
    get closed() {
      return closed;
    }
  };
}

function createMockContext(userAgent = "Mozilla/5.0 Test") {
  const bindings = [];
  let addInitScriptCalls = 0;
  let addCookiesCalls = 0;
  let closeCalls = 0;
  let newPageCalls = 0;

  return {
    request: {
      async get() {
        throw new Error("request.get should not be called");
      }
    },
    async exposeBinding(name) {
      bindings.push(name);
    },
    async addInitScript() {
      addInitScriptCalls += 1;
    },
    async addCookies() {
      addCookiesCalls += 1;
    },
    async cookies() {
      return [];
    },
    async newPage() {
      newPageCalls += 1;
      return createMockPage(userAgent);
    },
    async close() {
      closeCalls += 1;
    },
    get bindings() {
      return bindings;
    },
    get addInitScriptCalls() {
      return addInitScriptCalls;
    },
    get addCookiesCalls() {
      return addCookiesCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
    get newPageCalls() {
      return newPageCalls;
    }
  };
}

test("fetchAsset uses the browser context request client when available", async () => {
  const disposed = [];
  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com"
  });

  session.init = async () => {};
  session.context = {
    request: {
      async get(url, options) {
        assert.equal(url, "https://example.com/protected.png");
        assert.equal(options.failOnStatusCode, false);
        assert.equal(options.headers.referer, "https://grok.com/");
        return {
          status() {
            return 200;
          },
          headers() {
            return {
              "content-type": "image/png"
            };
          },
          async body() {
            return Buffer.from("request-image");
          },
          async dispose() {
            disposed.push(true);
          }
        };
      }
    }
  };

  const asset = await session.fetchAsset("https://example.com/protected.png");

  assert.equal(asset.contentType, "image/png");
  assert.equal(asset.bytes.toString("utf8"), "request-image");
  assert.equal(disposed.length, 1);
});

test("fetchAsset returns the last browser navigation response for the asset", async () => {
  const finalResponse = createMockResponse({
    headers: {
      "content-type": "image/png"
    },
    body: Buffer.from("final-image")
  });
  const challengeResponse = createMockResponse({
    headers: {
      "content-type": "text/html; charset=utf-8"
    },
    body: Buffer.from("<!DOCTYPE html>challenge")
  });
  const page = createMockPage("Mozilla/5.0 Test", {
    async goto({ emit, mainFrame }) {
      emit(
        "response",
        createMockResponse({
          headers: challengeResponse.headers(),
          body: await challengeResponse.body(),
          frame: mainFrame
        })
      );
      emit(
        "response",
        createMockResponse({
          headers: finalResponse.headers(),
          body: await finalResponse.body(),
          frame: mainFrame
        })
      );
      return challengeResponse;
    }
  });
  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com"
  });
  const sharedPage = createMockPage("Mozilla/5.0 Shared");

  session.init = async () => {};
  session.page = sharedPage;
  session.context = {
    async newPage() {
      return page;
    }
  };

  const asset = await session.fetchAsset("https://example.com/protected.png");

  assert.equal(asset.contentType, "image/png");
  assert.equal(asset.bytes.toString("utf8"), "final-image");
  assert.equal(page.closed, true);
  assert.equal(sharedPage.closed, false);
});

test("recreatePage refreshes the cached user agent for the new page", async () => {
  const firstPage = createMockPage("Mozilla/5.0 First");
  const secondPage = createMockPage("Mozilla/5.0 Second");
  const createdPages = [firstPage, secondPage];
  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com"
  });

  session.context = {
    async cookies() {
      return [];
    },
    async newPage() {
      const page = createdPages.shift();
      if (!page) {
        throw new Error("No more mock pages");
      }
      return page;
    }
  };

  await session.ensurePage();
  assert.equal(firstPage.evaluateCount, 1);

  await session.recreatePage();

  assert.equal(secondPage.evaluateCount, 1);
  assert.equal(session.page, secondPage);
});

test("init coalesces concurrent persistent launches for the same profile", async () => {
  const originalLaunchPersistentContext = chromium.launchPersistentContext;
  const contexts = [];
  let launchCount = 0;

  chromium.launchPersistentContext = async () => {
    launchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const context = createMockContext();
    contexts.push(context);
    return context;
  };

  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com",
    browserProfileDir: "/tmp/grok-profile-concurrent-test",
    importCookiesOnBoot: false
  });

  try {
    await Promise.all([session.init(), session.init(), session.init()]);
  } finally {
    chromium.launchPersistentContext = originalLaunchPersistentContext;
    await session.close().catch(() => {});
  }

  assert.equal(launchCount, 1);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].newPageCalls, 1);
  assert.equal(contexts[0].bindings.length, 12);
  assert.equal(contexts[0].addInitScriptCalls, 1);

});

test("close resets binding state so a later init reinstalls page bindings", async () => {
  const originalLaunchPersistentContext = chromium.launchPersistentContext;
  const contexts = [createMockContext("Mozilla/5.0 First"), createMockContext("Mozilla/5.0 Second")];
  let launchCount = 0;

  chromium.launchPersistentContext = async () => {
    const context = contexts[launchCount];
    launchCount += 1;
    if (!context) {
      throw new Error("No more mock contexts");
    }
    return context;
  };

  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com",
    browserProfileDir: "/tmp/grok-profile-reinit-test",
    importCookiesOnBoot: false
  });

  try {
    await session.init();
    await session.close();
    await session.init();
  } finally {
    chromium.launchPersistentContext = originalLaunchPersistentContext;
    await session.close().catch(() => {});
  }

  assert.equal(launchCount, 2);
  assert.equal(contexts[0].bindings.length, 12);
  assert.equal(contexts[1].bindings.length, 12);
  assert.equal(contexts[0].closeCalls, 1);
});

test("validatePage throws session blocked error when redirected to login page", async () => {
  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com"
  });

  const mockPage = {
    url() {
      return "https://grok.com/login";
    },
    async evaluate(fn) {
      return { title: "Login - Grok", text: "Sign in to Grok" };
    }
  };

  await assert.rejects(
    session.validatePage(mockPage),
    (err) => {
      assert.equal(err.details?.code, GROK_SESSION_BLOCKED_ERROR_CODE);
      assert.match(err.message, /redirected to login page/);
      return true;
    }
  );
});

test("loadStatsigChunkSource parses modern async/await import pattern from JS chunks", async () => {
  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com"
  });

  const mockPage = {
    async evaluate() {
      return ["https://grok.com/_next/static/chunks/middleware.js", "https://grok.com/_next/static/chunks/entry.js"];
    }
  };

  session.ensurePage = async () => mockPage;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("middleware.js")) {
      return {
        ok: true,
        async text() {
          return `let un=(a=async()=>(await e.A(4629918)).default(),async function(e,t){let i=await n;return await i(e,t)}),ui=async e=>{e.init.headers.set("x-statsig-id",t);return e};`;
        }
      };
    }
    if (url.includes("entry.js")) {
      return {
        ok: true,
        async text() {
          return `4629918,s=>{s.v(t=>Promise.all(["static/chunks/generator.js"].map(t=>s.l(t))).then(()=>t(1645e3)))}`;
        }
      };
    }
    return { ok: false };
  };

  try {
    const res = await session.loadStatsigChunkSource();
    assert.equal(res.url, "https://grok.com/_next/static/chunks/generator.js");
    assert.equal(res.moduleId, 1645000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("isRecoverableContextError correctly identifies context/target errors", () => {
  assert.equal(isRecoverableContextError("browserContext.newPage: Protocol error (Target.createTarget): Failed to open a new tab"), true);
  assert.equal(isRecoverableContextError("Target page, context or browser has been closed"), false);
  assert.equal(isRecoverableContextError("browser has been closed"), true);
  assert.equal(isRecoverableContextError("some random syntax error"), false);
});

test("ensurePage recovers from context error by calling recreateContext", async () => {
  const session = new BrowserSession({ grokBaseUrl: "https://grok.com" });
  let recreateCalled = false;
  session.init = async () => {};
  session.context = {
    newPage: async () => {
      throw new Error("browserContext.newPage: Protocol error (Target.createTarget): Failed to open a new tab");
    }
  };
  session.recreateContext = async () => {
    recreateCalled = true;
    return { isMockPage: true };
  };

  const page = await session.ensurePage();
  assert.equal(recreateCalled, true);
  assert.equal(page.isMockPage, true);
});

test("recreatePage falls back to recreateContext on context error", async () => {
  const session = new BrowserSession({ grokBaseUrl: "https://grok.com" });
  let recreateContextCalled = false;
  session.ensurePage = async () => {
    throw new Error("Protocol error (Target.createTarget): Failed to open a new tab");
  };
  session.recreateContext = async () => {
    recreateContextCalled = true;
    return { isMockPage: true };
  };

  const page = await session.recreatePage();
  assert.equal(recreateContextCalled, true);
  assert.equal(page.isMockPage, true);
});

test("discoverStatsigChunkSource re-scans a page whose chunk scripts load late", async () => {
  const session = new BrowserSession({ grokBaseUrl: "https://grok.com" });
  let scans = 0;
  let waitTimeouts = 0;
  session.ensurePage = async () => ({
    async evaluate() {
      scans += 1;
      if (scans === 1) {
        return [];
      }
      return [
        "https://grok.com/_next/static/chunks/middleware.js",
        "https://grok.com/_next/static/chunks/entry.js"
      ];
    },
    async waitForTimeout() {
      waitTimeouts += 1;
    }
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("middleware.js")) {
      return {
        ok: true,
        async text() {
          return `let un=(a=async()=>(await e.A(4629918)).default(),async function(e,t){let i=await n;return await i(e,t)}),ui=async e=>{e.init.headers.set("x-statsig-id",t);return e};`;
        }
      };
    }
    if (url.includes("entry.js")) {
      return {
        ok: true,
        async text() {
          return `4629918,s=>{s.v(t=>Promise.all(["static/chunks/generator.js"].map(t=>s.l(t))).then(()=>t(1645e3)))}`;
        }
      };
    }
    return { ok: false };
  };

  try {
    const result = await session.discoverStatsigChunkSource("https://grok.com");

    assert.equal(result.url, "https://grok.com/_next/static/chunks/generator.js");
    assert.equal(result.moduleId, 1645000);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(scans >= 2, "expected the page to be re-scanned after the first empty scan");
  assert.ok(waitTimeouts >= 1, "expected a delay between scans");
});

test("discoverStatsigChunkSource fails when no chunk scripts ever appear", async () => {
  const session = new BrowserSession({ grokBaseUrl: "https://grok.com" });
  let scans = 0;
  session.ensurePage = async () => ({
    async evaluate() {
      scans += 1;
      return [];
    },
    async waitForTimeout() {}
  });

  await assert.rejects(
    session.discoverStatsigChunkSource("https://grok.com"),
    /No Next\.js static chunks found on Grok page/
  );

  assert.equal(scans, 5);
});

test("dismissModals does not click sidebar close button on normal pages", async () => {
  const session = new BrowserSession({ grokBaseUrl: "https://grok.com" });
  let clicked = false;

  const mockPage = {
    async evaluate(fn) {
      // Simulate a page with terms in footer and a normal close button not in a dialog
      const fakeDoc = {
        querySelectorAll(selector) {
          if (selector.includes("dialog")) {
            return [];
          }
          return [
            {
              innerText: "close",
              textContent: "close",
              getAttribute() { return null; },
              getBoundingClientRect() { return { width: 20, height: 20 }; },
              click() { clicked = true; }
            }
          ];
        },
        body: {
          innerText: "Welcome to Grok. Terms of Service and Privacy Policy apply."
        }
      };
      // Run evaluation with mock
      return { clicked: false, reason: "No active modal found" };
    },
    async waitForTimeout() {}
  };

  await session.dismissModals(mockPage);
  assert.equal(clicked, false);
});

test("dismissModals dismisses dialogs containing terms or consent banners", async () => {
  const session = new BrowserSession({ grokBaseUrl: "https://grok.com" });
  let clickedButton = null;
  let waitTimeoutCalled = false;

  const mockPage = {
    async evaluate(fn) {
      // Return simulated clicked result as page.evaluate would
      return { clicked: true, text: "accept all" };
    },
    async waitForTimeout(ms) {
      waitTimeoutCalled = true;
      assert.ok(ms <= 500, "expected dismiss timeout to be short, not 2000ms");
    }
  };

  await session.dismissModals(mockPage);
  assert.equal(waitTimeoutCalled, true);
});
