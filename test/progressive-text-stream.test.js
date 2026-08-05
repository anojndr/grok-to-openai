import test from "node:test";
import assert from "node:assert/strict";
import { createProgressiveTextStream } from "../src/openai/progressive-text-stream.js";

test("progressive text stream emits deltas as they arrive", () => {
  const events = [];
  const stream = createProgressiveTextStream({
    onActivity() {
      events.push({ type: "activity" });
    },
    onText(text) {
      events.push({ type: "text", text });
    }
  });

  stream.observe("Hello");
  stream.observe(" world");

  assert.deepEqual(events, [
    { type: "activity" },
    { type: "text", text: "Hello" },
    { type: "text", text: " world" }
  ]);

  assert.equal(stream.finish("Hello world"), "Hello world");
  assert.deepEqual(events, [
    { type: "activity" },
    { type: "text", text: "Hello" },
    { type: "text", text: " world" }
  ]);
});

test("progressive text stream sanitizes markup spans that span token boundaries", () => {
  const events = [];
  const stream = createProgressiveTextStream({
    onActivity() {
      events.push({ type: "activity" });
    },
    onText(text) {
      events.push({ type: "text", text });
    }
  });

  stream.observe("Before <xai:tool_usage_card>");
  stream.observe("<xai:tool_usage_card_id>c1</xai:tool_usage_card_id>");
  stream.observe("</xai:tool_usage_card> after");

  assert.deepEqual(events, [
    { type: "activity" },
    { type: "text", text: "Before " },
    { type: "text", text: " after" }
  ]);
});

test("progressive text stream emits the canonical text when the live stream diverges", () => {
  const events = [];
  const stream = createProgressiveTextStream({
    onActivity() {
      events.push({ type: "activity" });
    },
    onText(text) {
      events.push({ type: "text", text });
    }
  });

  stream.observe("Roughly 2–3 times per week.");

  const canonicalText = `Roughly 2–3 times per week.

No public statements or data exist on Ado specifically. This is an educated estimate based on typical frequencies reported for women in their early 20s across multiple surveys.`;

  assert.equal(stream.finish(canonicalText), canonicalText);
  assert.deepEqual(events, [
    { type: "activity" },
    { type: "text", text: "Roughly 2–3 times per week." },
    { type: "text", text: canonicalText }
  ]);
});

test("progressive text stream emits activity and text when only canonical text exists", () => {
  const events = [];
  const stream = createProgressiveTextStream({
    onActivity() {
      events.push({ type: "activity" });
    },
    onText(text) {
      events.push({ type: "text", text });
    }
  });

  assert.equal(stream.finish("Canonical final answer."), "Canonical final answer.");
  assert.deepEqual(events, [
    { type: "activity" },
    { type: "text", text: "Canonical final answer." }
  ]);
});
