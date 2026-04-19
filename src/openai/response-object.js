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
    ...(image.url ? { result_url: image.url } : {}),
    ...(image.mimeType ? { mime_type: image.mimeType } : {}),
    ...(image.prompt ? { prompt: image.prompt } : {}),
    ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}),
    ...(image.action ? { action: image.action } : {}),
    ...(image.imageModel ? { image_model: image.imageModel } : {}),
    ...(image.title ? { title: image.title } : {}),
    ...(image.thumbnailUrl ? { thumbnail_url: image.thumbnailUrl } : {}),
    ...(image.sourcePageUrl ? { source_page_url: image.sourcePageUrl } : {}),
    ...(image.sourceTitle ? { source_title: image.sourceTitle } : {}),
    ...(image.sourceName ? { source_name: image.sourceName } : {}),
    ...(image.resultError ? { result_error: image.resultError } : {}),
    ...(outputFormat ? { output_format: outputFormat } : {})
  };
}

function isImageOutputItem(item) {
  return item?.type === "image_generation_call";
}

export function stripImageResultsFromResponse(response) {
  const output = response?.output;

  if (!Array.isArray(output) || !output.some((item) => isImageOutputItem(item) && "result" in item)) {
    return response;
  }

  return {
    ...response,
    output: output.map((item) => {
      if (!isImageOutputItem(item) || !("result" in item)) {
        return item;
      }

      const { result: _result, ...withoutResult } = item;
      return withoutResult;
    })
  };
}

function getLatestAssistantAttachments(history) {
  const messages = history?.messages ?? [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return messages[index].attachments ?? [];
    }
  }

  return [];
}

export async function hydrateResponseImageResults({
  response,
  history,
  fileStore
}) {
  const output = response?.output;

  if (!Array.isArray(output) || !output.some(isImageOutputItem)) {
    return response;
  }

  const attachments = getLatestAssistantAttachments(history);
  if (!attachments.length) {
    return response;
  }

  let attachmentIndex = 0;
  let changed = false;
  const hydratedOutput = await Promise.all(
    output.map(async (item) => {
      if (!isImageOutputItem(item)) {
        return item;
      }

      const attachment = attachments[attachmentIndex++];

      if (typeof item.result === "string" && item.result) {
        return item;
      }

      if (!attachment?.fileId) {
        return item;
      }

      const bytes = await fileStore.getContent(attachment.fileId);
      if (!bytes) {
        if (item.result_error) {
          return item;
        }

        changed = true;
        return {
          ...item,
          result_error: `Stored conversation attachment is missing: ${attachment.fileId}`
        };
      }

      changed = true;
      return {
        ...item,
        result: bytes.toString("base64"),
        ...(item.mime_type ? {} : { mime_type: attachment.mimeType || "application/octet-stream" })
      };
    })
  );

  return changed
    ? {
        ...response,
        output: hydratedOutput
      }
    : response;
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
