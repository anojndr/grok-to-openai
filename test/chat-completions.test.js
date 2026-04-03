import test from "node:test";
import assert from "node:assert/strict";
import {
  createChatCompletion,
  renderChatCompletionContent
} from "../src/openai/chat-completions.js";

test("renderChatCompletionContent appends markdown image embeds", () => {
  const content = renderChatCompletionContent({
    text: "Here you go.",
    images: [
      {
        title: "Generated Image",
        url: "https://assets.grok.com/generated/cat.jpg"
      }
    ]
  });

  assert.equal(
    content,
    "Here you go.\n\n![Generated Image](https://assets.grok.com/generated/cat.jpg)"
  );
});

test("createChatCompletion exposes bridge-specific image urls", () => {
  const response = createChatCompletion({
    model: "grok-4-auto",
    content: "![Generated Image](https://assets.grok.com/generated/cat.jpg)",
    imageUrls: [
      {
        url: "https://assets.grok.com/generated/cat.jpg",
        mimeType: "image/jpeg",
        title: "Generated Image",
        action: "generate",
        prompt: "generate an image of a cat",
        revisedPrompt: "a refined cat prompt",
        imageModel: "imagine_x_1"
      }
    ]
  });

  assert.deepEqual(response.choices[0].message.image_urls, [
    {
      url: "https://assets.grok.com/generated/cat.jpg",
      mime_type: "image/jpeg",
      title: "Generated Image",
      action: "generate",
      prompt: "generate an image of a cat",
      revised_prompt: "a refined cat prompt",
      image_model: "imagine_x_1"
    }
  ]);
});
