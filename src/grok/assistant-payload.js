function normalizeAssistantMessageText(text) {
  return typeof text === "string" ? text.trim() : "";
}

export function isThinkingPlaceholderMessage(text) {
  const normalized = normalizeAssistantMessageText(text);
  return /^thinking about your request(?:\.{3}|[.!?])?$/i.test(normalized);
}

export function hasUsableAssistantMessage(response) {
  const message = normalizeAssistantMessageText(response?.message);
  return Boolean(message) && !isThinkingPlaceholderMessage(message);
}

export function hasRenderableAssistantPayload(response) {
  if (!response || typeof response !== "object") {
    return false;
  }

  if (hasUsableAssistantMessage(response)) {
    return true;
  }

  if ((response.generatedImageUrls ?? []).length > 0) {
    return true;
  }

  return (response.cardAttachmentsJson ?? []).length > 0;
}

export function hasCompleteAssistantPayload(response) {
  if (!response || typeof response !== "object") {
    return false;
  }

  if (hasRenderableAssistantPayload(response)) {
    return true;
  }

  if (response.partial !== false) {
    return false;
  }

  return !isThinkingPlaceholderMessage(response.message);
}
