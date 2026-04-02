import test from "node:test";
import assert from "node:assert/strict";
import { splitInstructionsAndMessages } from "../src/openai/input.js";

test("splitInstructionsAndMessages keeps system text in instructions", () => {
  const result = splitInstructionsAndMessages(
    [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" }
    ],
    "Default instruction"
  );

  assert.equal(result.instructions, "Default instruction\n\nBe concise.");
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "user");
});
