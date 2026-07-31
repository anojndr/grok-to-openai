import test from "node:test";
import assert from "node:assert/strict";
import { createCanonicalTextStream } from "../src/openai/canonical-text-stream.js";

test("canonical text stream discards provisional Grok preambles", () => {
  const events = [];
  const stream = createCanonicalTextStream({
    onActivity() {
      events.push({ type: "activity" });
    },
    onText(text) {
      events.push({ type: "text", text });
    }
  });

  stream.observe("I'll check for any public statements or relevant data first.");
  stream.observe("Roughly 2–3 times per week.");

  assert.deepEqual(events, [{ type: "activity" }]);

  const canonicalText = `Roughly 2–3 times per week.

No public statements or data exist on Ado specifically. This is an educated estimate based on typical frequencies reported for women in their early 20s across multiple surveys.`;

  assert.equal(stream.finish(canonicalText), canonicalText);
  assert.deepEqual(events, [
    { type: "activity" },
    { type: "text", text: canonicalText }
  ]);
});
