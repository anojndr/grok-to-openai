import { createId, unixTimestampSeconds } from "../lib/ids.js";

function createUsage() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_tokens_details: {
      cached_tokens: 0,
      audio_tokens: 0
    },
    completion_tokens_details: {
      reasoning_tokens: 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0
    }
  };
}

function normalizeImageUrls(images) {
  return images.map((image) => ({
    url: image.url,
    mime_type: image.mimeType ?? null,
    title: image.title ?? null,
    action: image.action ?? null,
    prompt: image.prompt ?? null,
    revised_prompt: image.revisedPrompt ?? null,
    image_model: image.imageModel ?? null
  }));
}

export function renderChatCompletionContent({ text = "", images = [] }) {
  if (!images.length) {
    return text;
  }

  const markdownImages = images.map((image, index) => {
    const fallbackLabel =
      image.title ||
      (image.action === "edit" ? "Edited image" : "Generated image");
    const label = images.length > 1 ? `${fallbackLabel} ${index + 1}` : fallbackLabel;
    return `![${label}](${image.url})`;
  });

  if (!text) {
    return markdownImages.join("\n\n");
  }

  return `${text}\n\n${markdownImages.join("\n\n")}`;
}

export function createChatCompletion({
  id = createId("chatcmpl"),
  model,
  content,
  imageUrls = [],
  sourceAttribution = null,
  finishReason = "stop",
  created = unixTimestampSeconds()
}) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          refusal: null,
          annotations: [],
          ...(imageUrls.length
            ? { image_urls: normalizeImageUrls(imageUrls) }
            : {})
        },
        logprobs: null,
        finish_reason: finishReason
      }
    ],
    usage: createUsage(),
    service_tier: "default",
    source_attribution: sourceAttribution
  };
}

export function createChatCompletionChunk({
  id,
  model,
  delta,
  finishReason = null,
  created = unixTimestampSeconds()
}) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason
      }
    ]
  };
}
