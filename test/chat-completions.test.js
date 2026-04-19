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

test("createChatCompletion preserves searched image source metadata", () => {
  const response = createChatCompletion({
    model: "grok-4-auto",
    content: "![Example Source image](https://images.example.com/face.jpg)",
    imageUrls: [
      {
        url: "https://images.example.com/face.jpg",
        mimeType: "image/jpeg",
        title: "Example Source image",
        action: "search",
        thumbnailUrl: "https://images.example.com/thumb-face.jpg",
        sourcePageUrl: "https://example.com/articles/face",
        sourceTitle: "Article title",
        sourceName: "Example Source"
      }
    ]
  });

  assert.deepEqual(response.choices[0].message.image_urls, [
    {
      url: "https://images.example.com/face.jpg",
      mime_type: "image/jpeg",
      title: "Example Source image",
      action: "search",
      prompt: null,
      revised_prompt: null,
      image_model: null,
      thumbnail_url: "https://images.example.com/thumb-face.jpg",
      source_page_url: "https://example.com/articles/face",
      source_title: "Article title",
      source_name: "Example Source"
    }
  ]);
});
