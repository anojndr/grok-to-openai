import test from "node:test";
import assert from "node:assert/strict";
import {
  createGrokMarkupStreamSanitizer,
  sanitizeGrokMarkup
} from "../src/grok/markup.js";

const MAX_START_LENGTH = Math.max(
  "<xai:tool_usage_card>".length,
  "<grok:render".length
);

test("sanitizeGrokMarkup removes tool cards and inline grok render tags", () => {
  const input = `<xai:tool_usage_card><xai:tool_name>web_search</xai:tool_name></xai:tool_usage_card>Hello<grok:render card_id="1" card_type="citation_card" type="render_inline_citation"><argument name="citation_id">6</argument></grok:render> world`;
  assert.equal(sanitizeGrokMarkup(input), "Hello world");
});

test("createGrokMarkupStreamSanitizer hides markup across chunk boundaries", () => {
  const sanitizer = createGrokMarkupStreamSanitizer();
  const combined =
    sanitizer.write("<xai:tool_usage_card><xai:tool_name>") +
    sanitizer.write("web_search</xai:tool_name></xai:tool_usage_card>Hello") +
    sanitizer.write("<grok:render card_id=\"1\">x</grok:render> world") +
    sanitizer.flush();

  assert.equal(combined, "Hello world");
});

test("createGrokMarkupStreamSanitizer can stop emitting once citations begin", () => {
  const sanitizer = createGrokMarkupStreamSanitizer({ stopAtRenderTag: true });
  const combined =
    sanitizer.write("<xai:tool_usage_card><xai:tool_name>web_search</xai:tool_name></xai:tool_usage_card>Hello") +
    sanitizer.write("<grok:render card_id=\"1\" card_type=\"citation_card\" type=\"render_inline_citation\"><argument name=\"citation_id\">6</argument></grok:render> world") +
    sanitizer.flush();

  assert.equal(combined, "Hello");
});

test("createGrokMarkupStreamSanitizer does not split emoji surrogate pairs across deferred boundaries", () => {
  const sanitizer = createGrokMarkupStreamSanitizer();
  const visibleText = `A😀${"b".repeat(MAX_START_LENGTH - 2)}`;
  const firstChunk = sanitizer.write(visibleText);
  const deferredChunk = sanitizer.flush();

  assert.equal(firstChunk, "A");
  assert.equal(deferredChunk, `😀${"b".repeat(MAX_START_LENGTH - 2)}`);
  assert.equal(firstChunk + deferredChunk, visibleText);
});
