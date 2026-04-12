import test from "node:test";
import assert from "node:assert/strict";
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
