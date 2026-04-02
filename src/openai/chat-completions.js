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

export function createChatCompletion({
  id = createId("chatcmpl"),
  model,
  content,
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
          annotations: []
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
