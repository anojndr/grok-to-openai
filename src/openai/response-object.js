import { createId, unixTimestampSeconds } from "../lib/ids.js";

export function createResponseEnvelope({
  id = createId("resp"),
  messageId = createId("msg"),
  model,
  text,
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
    output: [
      {
        id: messageId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
            annotations: []
          }
        ]
      }
    ],
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
    metadata
  };
}

export function createStreamingResponseSnapshot({
  id,
  model,
  instructions,
  previousResponseId,
  metadata,
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
    metadata
  };
}
