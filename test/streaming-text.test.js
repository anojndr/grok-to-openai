import test from "node:test";
import assert from "node:assert/strict";
import { getStreamingTextSuffix } from "../src/openai/streaming-text.js";

test("getStreamingTextSuffix returns the missing suffix when the stream is a prefix", () => {
  assert.equal(
    getStreamingTextSuffix("Canonical final answer.", "Canonical"),
    " final answer."
  );
});

test("getStreamingTextSuffix does not duplicate the tail after a mid-stream mismatch", () => {
  assert.equal(
    getStreamingTextSuffix(
      "The canonical response keeps going.",
      "The streamed response keeps going."
    ),
    ""
  );
});
