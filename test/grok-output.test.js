import test from "node:test";
import assert from "node:assert/strict";
import { buildAssistantOutput } from "../src/grok/output.js";

test("buildAssistantOutput prefers Grok's final model message", () => {
  const output = buildAssistantOutput(
    {
      assistantText: "Streamed draft that diverged from the final answer.",
      modelResponse: {
        message: "Canonical final answer."
      }
    },
    {}
  );

  assert.equal(output.text, "Canonical final answer.");
});

test("buildAssistantOutput still extracts query provenance from streamed markup", () => {
  const output = buildAssistantOutput(
    {
      assistantText:
        "<xai:tool_usage_card><xai:tool_usage_card_id>card-1</xai:tool_usage_card_id><xai:tool_name>web_search</xai:tool_name><xai:tool_args><![CDATA[{\"query\":\"maximize game window bug\",\"num_results\":\"5\"}]]></xai:tool_args></xai:tool_usage_card>",
      modelResponse: {
        message: "Canonical final answer."
      }
    },
    {
      include_search_queries: true
    }
  );

  assert.equal(output.text, "Canonical final answer.");
  assert.deepEqual(output.sourceAttribution.search_queries, [
    "maximize game window bug"
  ]);
});
