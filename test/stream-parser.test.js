import test from "node:test";
import assert from "node:assert/strict";
import {
  applyGrokEvent,
  collectGrokStreamingState
} from "../src/grok/stream-parser.js";

test("applyGrokEvent handles nested conversation-new streaming payloads", () => {
  const state = collectGrokStreamingState();

  const delta = applyGrokEvent(state, {
    result: {
      conversation: { conversationId: "conv_123" },
      response: {
        userResponse: { responseId: "user_123" },
        token: "Hello",
        llmInfo: { modelHash: "abc" }
      }
    }
  });

  assert.deepEqual(delta, {
    type: "token",
    token: "Hello",
    isThinking: false,
    messageTag: null,
    messageStepId: null,
    responseId: null,
    rolloutId: null
  });
  assert.equal(state.conversation.conversationId, "conv_123");
  assert.equal(state.userResponse.responseId, "user_123");
  assert.equal(state.assistantText, "Hello");
  assert.equal(state.llmInfo.modelHash, "abc");
});

test("applyGrokEvent handles flat follow-up streaming payloads", () => {
  const state = collectGrokStreamingState();

  const tokenDelta = applyGrokEvent(state, {
    result: {
      token: "Your",
      responseId: "resp_123"
    }
  });

  applyGrokEvent(state, {
    result: {
      finalMetadata: {
        followUpSuggestions: [{ label: "Why?" }]
      }
    }
  });

  applyGrokEvent(state, {
    result: {
      modelResponse: {
        responseId: "resp_123",
        message: "Your favorite color is cerulean."
      }
    }
  });

  assert.deepEqual(tokenDelta, {
    type: "token",
    token: "Your",
    isThinking: false,
    messageTag: null,
    messageStepId: null,
    responseId: "resp_123",
    rolloutId: null
  });
  assert.equal(state.assistantText, "Your");
  assert.equal(state.finalMetadata.followUpSuggestions[0].label, "Why?");
  assert.equal(state.modelResponse.message, "Your favorite color is cerulean.");
});

test("applyGrokEvent preserves thinking metadata for streamed expert tokens", () => {
  const state = collectGrokStreamingState();

  const delta = applyGrokEvent(state, {
    result: {
      response: {
        token: "Identifying popularity metrics",
        isThinking: true,
        messageTag: "header",
        messageStepId: 1,
        responseId: "resp_123",
        rolloutId: "Grok"
      }
    }
  });

  assert.deepEqual(delta, {
    type: "token",
    token: "Identifying popularity metrics",
    isThinking: true,
    messageTag: "header",
    messageStepId: 1,
    responseId: "resp_123",
    rolloutId: "Grok"
  });
  assert.equal(state.assistantText, "Identifying popularity metrics");
});

test("applyGrokEvent captures direct assistant response payloads", () => {
  const state = collectGrokStreamingState();

  applyGrokEvent(state, {
    result: {
      responseId: "resp_123",
      sender: "ASSISTANT",
      parentResponseId: "user_123",
      message: "Canonical final answer.",
      steps: [
        {
          text: ["Examining claims"],
          tags: ["header"]
        }
      ]
    }
  });

  assert.equal(state.modelResponse.responseId, "resp_123");
  assert.equal(state.modelResponse.message, "Canonical final answer.");
  assert.equal(state.assistantText, "Canonical final answer.");
});

test("applyGrokEvent does not seed assistant text from placeholder assistant responses", () => {
  const state = collectGrokStreamingState();

  applyGrokEvent(state, {
    result: {
      responseId: "resp_123",
      sender: "ASSISTANT",
      message: "Thinking about your request"
    }
  });

  assert.equal(state.assistantResponseId, "resp_123");
  assert.equal(state.modelResponse.message, "Thinking about your request");
  assert.equal(state.assistantText, "");
  assert.equal(state.assistantVisibleText, "");
});

test("applyGrokEvent ignores empty streamed tokens while preserving the response id", () => {
  const state = collectGrokStreamingState();

  const delta = applyGrokEvent(state, {
    result: {
      token: "",
      responseId: "resp_123"
    }
  });

  assert.equal(delta, null);
  assert.equal(state.assistantResponseId, "resp_123");
  assert.equal(state.sawVisibleToken, false);
  assert.equal(state.assistantText, "");
});
