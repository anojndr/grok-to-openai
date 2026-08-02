import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import {
  BrowserSession,
  GROK_SESSION_BLOCKED_ERROR_CODE,
  GROK_REQUEST_TIMEOUT_ERROR_CODE,
  ERROR_RESPONSE_TEXT_LIMIT,
  installGrokBridgePageHelpers,
  isRecoverableContextError
} from "../src/grok/browser-session.js";

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
    "__grokBridgeMeta",
    "grokBridgeMeta",
    "__grokBridgeChunk",
    "grokBridgeChunk",
    "__grokBridgeDone",
    "grokBridgeDone",
    "__grokBridgeError",
    "grokBridgeError"
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
    assert.deepEqual(initialScanSelectors, ["path[d]"]);
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
  assert.equal(contexts[0].bindings.length, 8);
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
  assert.equal(contexts[0].bindings.length, 8);
  assert.equal(contexts[1].bindings.length, 8);
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
