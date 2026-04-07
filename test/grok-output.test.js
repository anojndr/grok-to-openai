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

test("buildAssistantOutput can render streaming-friendly text without inline citation rewrites", () => {
  const output = buildAssistantOutput(
    {
      assistantText:
        "Alpha<grok:render card_id=\"card_1\" card_type=\"citation_card\" type=\"render_inline_citation\"><argument name=\"citation_id\">1</argument></grok:render> beta",
      modelResponse: {
        message:
          "Alpha<grok:render card_id=\"card_1\" card_type=\"citation_card\" type=\"render_inline_citation\"><argument name=\"citation_id\">1</argument></grok:render> beta",
        cardAttachmentsJson: [
          JSON.stringify({
            id: "card_1",
            type: "render_inline_citation",
            cardType: "citation_card",
            url: "https://example.com/report"
          })
        ]
      }
    },
    {
      inline_citations: false,
      include_sources: true
    }
  );

  assert.equal(
    output.text,
    "Alpha beta\n\nSources\n1. [example.com/report](https://example.com/report) [cited]"
  );
  assert.equal(output.sourceAttribution.inline_citations, "none");
  assert.deepEqual(output.sourceAttribution.citations, [
    {
      card_id: "card_1",
      url: "https://example.com/report",
      short_url: "example.com/report"
    }
  ]);
});

test("buildAssistantOutput extracts generated images from Grok image cards", () => {
  const output = buildAssistantOutput(
    {
      modelResponse: {
        responseId: "resp_123",
        message:
          "<grok:render card_id=\"card_1\" card_type=\"generated_image_card\" type=\"render_generated_image\"><argument name=\"prompt\">generate an image of a cat</argument><argument name=\"orientation\">portrait</argument></grok:render>",
        cardAttachmentsJson: [
          JSON.stringify({
            id: "card_1",
            type: "render_generated_image",
            cardType: "generated_image_card",
            image_chunk: {
              imageUuid: "image_123",
              imageUrl: "users/test/generated/image_123-part-0/image.jpg",
              seq: 0,
              progress: 50,
              imageTitle: "Generated Image",
              imageIndex: 0,
              imageModel: "imagine_x_1",
              imagePrompt: {
                prompt: "generate an image of a cat",
                upsampledPrompt: "a refined cat prompt"
              }
            }
          }),
          JSON.stringify({
            id: "card_1",
            type: "render_generated_image",
            cardType: "generated_image_card",
            image_chunk: {
              imageUuid: "image_123",
              imageUrl: "users/test/generated/image_123/image.jpg",
              seq: 1,
              progress: 100,
              imageTitle: "Generated Image",
              imageIndex: 0,
              imageModel: "imagine_x_1",
              imagePrompt: {
                prompt: "generate an image of a cat",
                upsampledPrompt: "a refined cat prompt"
              }
            }
          })
        ]
      }
    },
    {},
    {
      grokBaseUrl: "https://grok.com"
    }
  );

  assert.equal(output.text, "");
  assert.deepEqual(output.images, [
    {
      id: "ig_image_123",
      responseId: "resp_123",
      cardId: "card_1",
      action: "generate",
      title: "Generated Image",
      prompt: "generate an image of a cat",
      revisedPrompt: "a refined cat prompt",
      url: "https://assets.grok.com/users/test/generated/image_123/image.jpg",
      mimeType: "image/jpeg",
      imageModel: "imagine_x_1",
      imageIndex: 0,
      progress: 100,
      seq: 1,
      orientation: "portrait",
      sourceImageId: null
    }
  ]);
});

test("buildAssistantOutput reconstructs Grok Expert answers from streamed thought text", () => {
  const output = buildAssistantOutput(
    {
      assistantText: `Checking CPU query- User likely seeking top CPU recommendation, possibly tagged with a Discord mention.
- Searching for top CPUs in 2026 to provide current recommendations.
- Focusing on high-end CPUs for gaming and productivity in April 2026.
- Planning to search for "best CPU 2026" to find current flagship processors.
- Teammate Harper suggests AMD Ryzen 7 9850X3D or 9800X3D as top for gaming with 3D V-Cache.
Confirming top CPUs- Verifying AMD Ryzen 7 9850X3D as leading gaming CPU via search.
- Latest reviews confirm Ryzen 7 9800X3D as top gaming CPU, with 9850X3D offering slight clock speed improvements.
- Consensus points to AMD Ryzen 7 9850X3D as the absolute best performing CPU in April 2026.
- Sources highlight Ryzen 9 9950X3D as best overall, while 9800X3D excels in gaming.
- Direct answer: AMD Ryzen 7 9800X3D leads for gaming with 3D V-Cache boosting frame rates.
The best CPU right now is the AMD Ryzen 7 9850X3D. It delivers the highest gaming performance available thanks to its Zen 5 architecture paired with massive 3DFinalizing CPU recommendation- AMD Ryzen 7 9850X3D emerges as the newest fastest gaming CPU per CES announcements.
 V-Cache, which boosts frame rates far beyond anything else on the market.

For the absolute top end in both gaming and heavy productivity work like video editing or 3D rendering, step up to the AMD Ryzen 9 9950X3D instead. It handles everything without compromise.

Intel's latest Core Ultra chips trail in gaming even if they offer solid value in some productivity scenarios. AMD's AM5 platform also gives you better upgrade options down the line. If your build has a specific budget or focus beyond raw performance, the Ryzen 7 9800X3D is nearly as fast and often easier to find at a lower price.`,
      modelResponse: {
        steps: [
          {
            text: ["Checking CPU query"],
            tags: ["header"]
          },
          {
            text: [
              `- User likely seeking top CPU recommendation, possibly tagged with a Discord mention.
- Searching for top CPUs in 2026 to provide current recommendations.
- Focusing on high-end CPUs for gaming and productivity in April 2026.
- Planning to search for "best CPU 2026" to find current flagship processors.
- Teammate Harper suggests AMD Ryzen 7 9850X3D or 9800X3D as top for gaming with 3D V-Cache.
`
            ],
            tags: ["summary"]
          },
          {
            text: ["Confirming top CPUs"],
            tags: ["header"]
          },
          {
            text: [
              `- Verifying AMD Ryzen 7 9850X3D as leading gaming CPU via search.
- Latest reviews confirm Ryzen 7 9800X3D as top gaming CPU, with 9850X3D offering slight clock speed improvements.
- Consensus points to AMD Ryzen 7 9850X3D as the absolute best performing CPU in April 2026.
- Sources highlight Ryzen 9 9950X3D as best overall, while 9800X3D excels in gaming.
- Direct answer: AMD Ryzen 7 9800X3D leads for gaming with 3D V-Cache boosting frame rates.
`
            ],
            tags: ["summary"]
          },
          {
            text: ["Finalizing CPU recommendation"],
            tags: ["header"]
          },
          {
            text: [
              "- AMD Ryzen 7 9850X3D emerges as the newest fastest gaming CPU per CES announcements.\n"
            ],
            tags: ["summary"]
          }
        ]
      }
    },
    {}
  );

  assert.equal(
    output.text,
    `The best CPU right now is the AMD Ryzen 7 9850X3D. It delivers the highest gaming performance available thanks to its Zen 5 architecture paired with massive 3D V-Cache, which boosts frame rates far beyond anything else on the market.

For the absolute top end in both gaming and heavy productivity work like video editing or 3D rendering, step up to the AMD Ryzen 9 9950X3D instead. It handles everything without compromise.

Intel's latest Core Ultra chips trail in gaming even if they offer solid value in some productivity scenarios. AMD's AM5 platform also gives you better upgrade options down the line. If your build has a specific budget or focus beyond raw performance, the Ryzen 7 9800X3D is nearly as fast and often easier to find at a lower price.`
  );
  assert.equal(
    output.thoughtText,
    `Checking CPU query

- User likely seeking top CPU recommendation, possibly tagged with a Discord mention.
- Searching for top CPUs in 2026 to provide current recommendations.
- Focusing on high-end CPUs for gaming and productivity in April 2026.
- Planning to search for "best CPU 2026" to find current flagship processors.
- Teammate Harper suggests AMD Ryzen 7 9850X3D or 9800X3D as top for gaming with 3D V-Cache.

Confirming top CPUs

- Verifying AMD Ryzen 7 9850X3D as leading gaming CPU via search.
- Latest reviews confirm Ryzen 7 9800X3D as top gaming CPU, with 9850X3D offering slight clock speed improvements.
- Consensus points to AMD Ryzen 7 9850X3D as the absolute best performing CPU in April 2026.
- Sources highlight Ryzen 9 9950X3D as best overall, while 9800X3D excels in gaming.
- Direct answer: AMD Ryzen 7 9800X3D leads for gaming with 3D V-Cache boosting frame rates.

Finalizing CPU recommendation

- AMD Ryzen 7 9850X3D emerges as the newest fastest gaming CPU per CES announcements.`
  );
});
