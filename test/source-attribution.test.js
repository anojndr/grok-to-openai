import test from "node:test";
import assert from "node:assert/strict";
import {
  createSourceAttributionPayload,
  extractSourceAttribution,
  renderGrokText,
  resolveSourceAttributionOptions
} from "../src/grok/source-attribution.js";

function buildModelResponse() {
  return {
    webSearchResults: [
      {
        url: "https://example.com/report",
        title: "Example Report",
        preview: "Example preview"
      },
      {
        url: "https://news.example.org/article",
        title: "News Article",
        preview: "News preview"
      }
    ],
    cardAttachmentsJson: [
      JSON.stringify({
        id: "card_1",
        type: "render_inline_citation",
        cardType: "citation_card",
        url: "https://example.com/report"
      }),
      JSON.stringify({
        id: "card_2",
        type: "render_inline_citation",
        cardType: "citation_card",
        url: "https://news.example.org/article"
      })
    ],
    steps: [
      {
        toolUsageCards: [
          {
            toolUsageCardId: "search_1",
            webSearch: {
              args: {
                query: "alpha search"
              }
            }
          },
          {
            toolUsageCardId: "search_2",
            webSearch: {
              args: {
                query: "beta search"
              }
            }
          }
        ],
        toolUsageResults: [
          {
            toolUsageCardId: "search_1",
            webSearchResults: {
              results: [
                {
                  url: "https://example.com/report",
                  title: "Example Report",
                  preview: "Example preview"
                }
              ]
            }
          },
          {
            toolUsageCardId: "search_2",
            webSearchResults: {
              results: [
                {
                  url: "https://example.com/report",
                  title: "Example Report",
                  preview: "Example preview"
                },
                {
                  url: "https://news.example.org/article",
                  title: "News Article",
                  preview: "News preview"
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

test("renderGrokText preserves inline citations as clickable shortened urls", () => {
  const assistantText =
    "Alpha<grok:render card_id=\"card_1\" card_type=\"citation_card\" type=\"render_inline_citation\"><argument name=\"citation_id\">1</argument></grok:render><grok:render card_id=\"card_2\" card_type=\"citation_card\" type=\"render_inline_citation\"><argument name=\"citation_id\">2</argument></grok:render> beta";
  const sourceAttribution = extractSourceAttribution({
    assistantText,
    modelResponse: buildModelResponse()
  });

  const text = renderGrokText({
    text: assistantText,
    sourceAttribution,
    options: resolveSourceAttributionOptions()
  });

  assert.equal(
    text,
    "Alpha ([example.com/report](https://example.com/report), [news.example.org/article](https://news.example.org/article)) beta"
  );
});

test("extractSourceAttribution maps sources back to the search queries that returned them", () => {
  const sourceAttribution = extractSourceAttribution({
    assistantText: "",
    modelResponse: buildModelResponse()
  });

  assert.deepEqual(sourceAttribution.searchQueries, ["alpha search", "beta search"]);
  assert.deepEqual(
    sourceAttribution.sources.map((source) => ({
      url: source.url,
      cited: source.cited,
      searchQueries: source.searchQueries
    })),
    [
      {
        url: "https://example.com/report",
        cited: true,
        searchQueries: ["alpha search", "beta search"]
      },
      {
        url: "https://news.example.org/article",
        cited: true,
        searchQueries: ["beta search"]
      }
    ]
  );
});

test("createSourceAttributionPayload exposes full sources and search queries only when requested", () => {
  const sourceAttribution = extractSourceAttribution({
    assistantText: "",
    modelResponse: buildModelResponse()
  });
  const payload = createSourceAttributionPayload({
    sourceAttribution,
    options: resolveSourceAttributionOptions({
      include_sources: true,
      include_search_queries: true
    })
  });

  assert.equal(payload.inline_citations, "short_url_markdown");
  assert.equal(payload.citations.length, 2);
  assert.equal(payload.sources.length, 2);
  assert.deepEqual(payload.search_queries, ["alpha search", "beta search"]);
  assert.deepEqual(payload.sources[0].search_queries, ["alpha search", "beta search"]);
});

test("renderGrokText can append a full source list with per-source queries", () => {
  const assistantText =
    "<xai:tool_usage_card><xai:tool_usage_card_id>search_1</xai:tool_usage_card_id><xai:tool_name>web_search</xai:tool_name><xai:tool_args><![CDATA[{\"query\":\"alpha search\"}]]></xai:tool_args></xai:tool_usage_card>Alpha<grok:render card_id=\"card_1\" card_type=\"citation_card\" type=\"render_inline_citation\"><argument name=\"citation_id\">1</argument></grok:render>";
  const sourceAttribution = extractSourceAttribution({
    assistantText,
    modelResponse: buildModelResponse()
  });

  const text = renderGrokText({
    text: assistantText,
    sourceAttribution,
    options: resolveSourceAttributionOptions({
      include_sources: true,
      include_search_queries: true
    })
  });

  assert.match(text, /Sources/);
  assert.match(text, /\[Example Report\]\(https:\/\/example\.com\/report\) \(example\.com\/report\) \[cited\] via `alpha search`; `beta search`/);
  assert.match(text, /Search Queries/);
  assert.match(text, /1\. `alpha search`/);
});
