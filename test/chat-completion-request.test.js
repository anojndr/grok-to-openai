import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareChatCompletionRequest,
  runPreparedChatCompletionRequest
} from "../src/openai/chat-completion-request.js";

test("prepareChatCompletionRequest parses, normalizes, and resolves once", async () => {
  const reqBody = {
    model: "grok-4-fast",
    messages: [{ role: "user", content: "Hello" }]
  };
  const parsed = {
    ...reqBody,
    metadata: { trace: "1" }
  };
  const normalized = {
    instructions: "Be concise.",
    messages: [{ role: "user", text: "Hello", files: [] }]
  };
  const calls = [];

  const prepared = await prepareChatCompletionRequest(reqBody, {
    fileStore: { sentinel: "store" },
    defaultModel: "grok-4-auto",
    parse(value) {
      calls.push(["parse", value]);
      return parsed;
    },
    async normalize({ requestBody, fileStore }) {
      calls.push(["normalize", requestBody, fileStore]);
      return normalized;
    },
    resolve(requestedModel, reasoningEffort, fallbackModel) {
      calls.push(["resolve", requestedModel, reasoningEffort, fallbackModel]);
      return { publicModel: "resolved-public-model" };
    }
  });

  assert.deepEqual(prepared, {
    parsed,
    normalized,
    publicModel: "resolved-public-model"
  });
  assert.deepEqual(calls, [
    ["parse", reqBody],
    ["normalize", parsed, { sentinel: "store" }],
    ["resolve", "grok-4-fast", undefined, "grok-4-auto"]
  ]);
});

test("runPreparedChatCompletionRequest uses prepared context without re-parsing or re-resolving", async () => {
  const prepared = {
    parsed: {
      model: "grok-4-fast",
      messages: [{ role: "user", content: "Hello" }]
    },
    normalized: {
      instructions: "Be concise.",
      messages: [{ role: "user", text: "Hello", files: [] }]
    },
    publicModel: "resolved-public-model"
  };

  const result = await runPreparedChatCompletionRequest(prepared, {
    async executeConversationRequest(request) {
      assert.deepEqual(request, {
        instructions: "Be concise.",
        publicModel: "resolved-public-model",
        message: "Hello",
        files: [],
        onToken: null
      });
      return { ok: true };
    },
    async executeManualHistory() {
      throw new Error("executeManualHistory should not be used for a single user message");
    }
  });

  assert.deepEqual(result, { ok: true });
});
