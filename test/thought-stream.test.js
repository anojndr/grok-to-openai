import test from "node:test";
import assert from "node:assert/strict";
import {
  createThoughtAndResponseStreamDeltas,
  renderGrokThought,
  renderThoughtAndResponse
} from "../src/grok/thought.js";

test("renderGrokThought formats headers and summaries and skips tool cards", () => {
  const thought = renderGrokThought({
    steps: [
      {
        text: ["Examining claims"],
        tags: ["header"]
      },
      {
        text: [
          "- Nuclear and thermal plants have robust safety systems, not single points of failure.\n- Grids operate under N-1 contingency standards.\n"
        ],
        tags: ["summary"]
      },
      {
        text: [
          "<xai:tool_usage_card><xai:tool_name>web_search</xai:tool_name></xai:tool_usage_card>"
        ],
        tags: ["tool_usage_card"]
      },
      {
        text: ["Drafting response"],
        tags: ["header"]
      }
    ]
  });

  assert.equal(
    thought,
    `Examining claims

- Nuclear and thermal plants have robust safety systems, not single points of failure.
- Grids operate under N-1 contingency standards.

Drafting response`
  );
});

test("renderThoughtAndResponse emits thought complete before the response", () => {
  const text = renderThoughtAndResponse({
    thoughtText: `Examining claims

- Point one
- Point two`,
    responseText: "Final answer."
  });

  assert.equal(
    text,
    `Examining claims

- Point one
- Point two

**thought complete**

Final answer.`
  );
});

test("renderThoughtAndResponse returns the response unchanged when no thought exists", () => {
  assert.equal(
    renderThoughtAndResponse({
      thoughtText: "",
      responseText: "Final answer."
    }),
    "Final answer."
  );
});

test("createThoughtAndResponseStreamDeltas separates thought, marker, and response", () => {
  assert.deepEqual(
    createThoughtAndResponseStreamDeltas({
      thoughtText: "Thought body",
      responseText: "Final answer."
    }),
    ["Thought body", "\n\n**thought complete**\n\n", "Final answer."]
  );
});
