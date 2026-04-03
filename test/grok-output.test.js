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
