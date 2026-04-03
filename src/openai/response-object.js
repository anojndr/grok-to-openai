import { createId, unixTimestampSeconds } from "../lib/ids.js";

function inferOutputFormat({ mimeType, resultUrl }) {
  const normalizedMime = (mimeType || "").toLowerCase();
  const normalizedUrl = (resultUrl || "").toLowerCase();

  if (normalizedMime.includes("png") || normalizedUrl.endsWith(".png")) {
    return "png";
  }

  if (
    normalizedMime.includes("jpeg") ||
    normalizedMime.includes("jpg") ||
    normalizedUrl.endsWith(".jpg") ||
    normalizedUrl.endsWith(".jpeg")
  ) {
    return "jpeg";
  }

  if (normalizedMime.includes("webp") || normalizedUrl.endsWith(".webp")) {
    return "webp";
  }

  if (normalizedMime.includes("gif") || normalizedUrl.endsWith(".gif")) {
    return "gif";
  }

  return null;
}

export function createResponseMessageOutputItem({
  id,
  text,
  status = "completed"
}) {
  return {
    id,
    type: "message",
    status,
    role: "assistant",
    content: [
      {
        type: "output_text",
        text,
        annotations: []
      }
    ]
  };
}

export function createResponseImageOutputItem({
  image,
  status = "completed"
}) {
  const outputFormat = inferOutputFormat({
    mimeType: image.mimeType,
    resultUrl: image.url
  });

  return {
    id: image.id,
    type: "image_generation_call",
    status,
    ...(status === "completed" ? { result: image.result ?? null } : {}),
    ...(image.url ? { result_url: image.url } : {}),
    ...(image.mimeType ? { mime_type: image.mimeType } : {}),
    ...(image.prompt ? { prompt: image.prompt } : {}),
    ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}),
    ...(image.action ? { action: image.action } : {}),
    ...(image.imageModel ? { image_model: image.imageModel } : {}),
    ...(image.title ? { title: image.title } : {}),
    ...(image.resultError ? { result_error: image.resultError } : {}),
    ...(outputFormat ? { output_format: outputFormat } : {})
  };
}

export function createResponseOutputItems({
  messageId,
  text,
  images = []
}) {
  const output = [];

  if (text) {
    output.push(
      createResponseMessageOutputItem({
        id: messageId,
        text
      })
    );
  }

  for (const image of images) {
    output.push(
      createResponseImageOutputItem({
        image
      })
    );
  }

  return output;
}

export function createResponseEnvelope({
  id = createId("resp"),
  messageId = createId("msg"),
  model,
  text,
  images = [],
  sourceAttribution = null,
  instructions = null,
  previousResponseId = null,
  metadata = {},
  store = true,
  request = {}
}) {
  const createdAt = unixTimestampSeconds();

  return {
    id,
    object: "response",
    created_at: createdAt,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: instructions || null,
    max_output_tokens: request.max_output_tokens ?? null,
    model,
    output: createResponseOutputItems({
      messageId,
      text,
      images
    }),
    parallel_tool_calls: true,
    previous_response_id: previousResponseId,
    reasoning: {
      effort: request.reasoning?.effort ?? null,
      summary: null
    },
    store,
    temperature: request.temperature ?? 1.0,
    text: request.text ?? { format: { type: "text" } },
    tool_choice: request.tool_choice ?? "auto",
    tools: request.tools ?? [],
    top_p: request.top_p ?? 1.0,
    truncation: request.truncation ?? "disabled",
    usage: null,
    user: null,
    metadata,
    source_attribution: sourceAttribution
  };
}

export function createStreamingResponseSnapshot({
  id,
  model,
  instructions,
  previousResponseId,
  metadata,
  sourceAttribution = null,
  request
}) {
  return {
    id,
    object: "response",
    created_at: unixTimestampSeconds(),
    status: "in_progress",
    error: null,
    incomplete_details: null,
    instructions: instructions || null,
    max_output_tokens: request.max_output_tokens ?? null,
    model,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: previousResponseId,
    reasoning: {
      effort: request.reasoning?.effort ?? null,
      summary: null
    },
    store: request.store ?? true,
    temperature: request.temperature ?? 1.0,
    text: request.text ?? { format: { type: "text" } },
    tool_choice: request.tool_choice ?? "auto",
    tools: request.tools ?? [],
    top_p: request.top_p ?? 1.0,
    truncation: request.truncation ?? "disabled",
    usage: null,
    user: null,
    metadata,
    source_attribution: sourceAttribution
  };
}
