import test from "node:test";
import assert from "node:assert/strict";
import { shouldBufferReasoningStream } from "../src/grok/streaming-policy.js";

test("shouldBufferReasoningStream buffers Grok Auto because it can escalate to expert behavior", () => {
  assert.equal(
    shouldBufferReasoningStream({
      model: "grok-4-auto"
    }),
    true
  );
  assert.equal(
    shouldBufferReasoningStream({
      model: "grok-4"
    }),
    true
  );
});

test("shouldBufferReasoningStream buffers expert-heavy style modes but not fast", () => {
  assert.equal(
    shouldBufferReasoningStream({
      model: "grok-4-expert"
    }),
    true
  );
  assert.equal(
    shouldBufferReasoningStream({
      model: "grok-4-heavy"
    }),
    true
  );
  assert.equal(
    shouldBufferReasoningStream({
      model: "grok-4-fast"
    }),
    false
  );
});

test("shouldBufferReasoningStream respects fallback and explicit high reasoning", () => {
  assert.equal(
    shouldBufferReasoningStream({
      fallbackModel: "grok-4-auto"
    }),
    true
  );
  assert.equal(
    shouldBufferReasoningStream({
      model: "grok-4-fast",
      reasoningEffort: "high"
    }),
    true
  );
});
