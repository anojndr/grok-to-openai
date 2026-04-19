import test from "node:test";
import assert from "node:assert/strict";
import { buildStoredGrokState } from "../src/grok/response-state.js";

test("buildStoredGrokState preserves the previous conversation id on follow-ups", () => {
  const grok = buildStoredGrokState({
    state: {
      conversation: null,
      modelResponse: { responseId: "assistant-2" },
      userResponse: { responseId: "user-2" }
    },
    accountIndex: 0,
    previousGrok: {
      accountIndex: 1,
      conversationId: "conversation-1",
      assistantResponseId: "assistant-1",
      userResponseId: "user-1"
    }
  });

  assert.deepEqual(grok, {
    accountIndex: 0,
    conversationId: "conversation-1",
    assistantResponseId: "assistant-2",
    userResponseId: "user-2"
  });
});

test("buildStoredGrokState prefers the latest conversation id when present", () => {
  const grok = buildStoredGrokState({
    state: {
      conversation: { conversationId: "conversation-2" },
      modelResponse: { responseId: "assistant-2" },
      userResponse: { responseId: "user-2" }
    },
    accountIndex: 2,
    previousGrok: {
      accountIndex: 1,
      conversationId: "conversation-1",
      assistantResponseId: "assistant-1",
      userResponseId: "user-1"
    }
  });

  assert.deepEqual(grok, {
    accountIndex: 2,
    conversationId: "conversation-2",
    assistantResponseId: "assistant-2",
    userResponseId: "user-2"
  });
});

test("buildStoredGrokState keeps the previous account index when a follow-up stays on the same account", () => {
  const grok = buildStoredGrokState({
    state: {
      conversation: null,
      modelResponse: { responseId: "assistant-2" },
      userResponse: { responseId: "user-2" }
    },
    previousGrok: {
      accountIndex: 1,
      conversationId: "conversation-1",
      assistantResponseId: "assistant-1",
      userResponseId: "user-1"
    }
  });

  assert.deepEqual(grok, {
    accountIndex: 1,
    conversationId: "conversation-1",
    assistantResponseId: "assistant-2",
    userResponseId: "user-2"
  });
});

test("buildStoredGrokState falls back to the streamed assistant response id when modelResponse is missing", () => {
  const grok = buildStoredGrokState({
    state: {
      conversation: { conversationId: "conversation-2" },
      assistantResponseId: "assistant-streamed",
      modelResponse: null,
      userResponse: { responseId: "user-2" }
    },
    accountIndex: 2,
    previousGrok: {
      accountIndex: 1,
      conversationId: "conversation-1",
      assistantResponseId: "assistant-1",
      userResponseId: "user-1"
    }
  });

  assert.deepEqual(grok, {
    accountIndex: 2,
    conversationId: "conversation-2",
    assistantResponseId: "assistant-streamed",
    userResponseId: "user-2"
  });
});
