import { HttpError } from "../lib/errors.js";
import { resolveModel } from "../grok/model-map.js";
import { chatCompletionsCreateSchema } from "./schema.js";
import { normalizeChatCompletionInput } from "./input.js";

function normalizeReasoningEffort(reasoningEffort) {
  if (reasoningEffort === "none" || reasoningEffort === "minimal") {
    return undefined;
  }

  return reasoningEffort;
}

export async function prepareChatCompletionRequest(reqBody, options = {}) {
  const parse = options.parse ?? ((value) => chatCompletionsCreateSchema.parse(value));
  const normalize =
    options.normalize ??
    ((value) => normalizeChatCompletionInput(value));
  const resolve = options.resolve ?? resolveModel;

  const parsed = parse(reqBody);
  const normalized = await normalize({
    requestBody: parsed,
    fileStore: options.fileStore
  });
  const { publicModel } = resolve(
    parsed.model,
    normalizeReasoningEffort(parsed.reasoning_effort),
    options.defaultModel
  );

  return {
    parsed,
    normalized,
    publicModel
  };
}

export async function runPreparedChatCompletionRequest(prepared, options) {
  const { parsed, normalized, publicModel } = prepared;
  const onToken = options?.onToken ?? null;

  if (!normalized.messages.length) {
    throw new HttpError(400, "messages must include at least one user message");
  }

  if (parsed.n && parsed.n !== 1) {
    throw new HttpError(400, "Only n=1 is supported");
  }

  if (normalized.messages.length === 1 && normalized.messages[0].role === "user") {
    const message = normalized.messages[0];
    return options.executeConversationRequest({
      instructions: normalized.instructions,
      publicModel,
      message: message.text,
      files: message.files,
      onToken
    });
  }

  return options.executeManualHistory({
    messages: normalized.messages,
    instructions: normalized.instructions,
    publicModel,
    onToken
  });
}
