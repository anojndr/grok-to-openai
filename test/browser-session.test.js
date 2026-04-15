import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import {
  BrowserSession,
  ERROR_RESPONSE_TEXT_LIMIT
} from "../src/grok/browser-session.js";

function createSession(evaluateRequest) {
  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com"
  });

  session.init = async () => {};
  session.loadStatsigChunkSource = async () => "statsig";
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

function createMockPage(userAgent) {
  let closed = false;
  let onClose = null;
  let evaluateCount = 0;

  return {
    async evaluate() {
      evaluateCount += 1;
      return userAgent;
    },
    async goto() {},
    on(event, handler) {
      if (event === "close") {
        onClose = handler;
      }
    },
    isClosed() {
      return closed;
    },
    async close() {
      closed = true;
      onClose?.();
    },
    get evaluateCount() {
      return evaluateCount;
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

test("fetchAsset reuses the cached page user agent across requests", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  const page = createMockPage("Mozilla/5.0 Test");
  const session = new BrowserSession({
    grokBaseUrl: "https://grok.com"
  });

  session.context = {
    async cookies() {
      return [];
    },
    async newPage() {
      return page;
    }
  };

  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({
      url,
      headers: options.headers
    });

    return new Response(Buffer.from("asset"), {
      status: 200,
      headers: {
        "content-type": "text/plain"
      }
    });
  };

  try {
    await session.fetchAsset("https://grok.com/assets/one");
    await session.fetchAsset("https://grok.com/assets/two");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(page.evaluateCount, 1);
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].headers["User-Agent"], "Mozilla/5.0 Test");
  assert.equal(fetchCalls[1].headers["User-Agent"], "Mozilla/5.0 Test");
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
