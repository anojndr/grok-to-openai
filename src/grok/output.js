import {
  createSourceAttributionPayload,
  extractSourceAttribution,
  renderGrokText,
  resolveSourceAttributionOptions
} from "./source-attribution.js";

export function buildAssistantOutput(state, sourceAttributionRequest) {
  const streamedText = state?.assistantText || "";
  const canonicalText = state?.modelResponse?.message || streamedText;
  const sourceAttributionOptions = resolveSourceAttributionOptions(
    sourceAttributionRequest
  );
  const sourceAttribution = extractSourceAttribution({
    assistantText: streamedText || canonicalText,
    modelResponse: state?.modelResponse ?? null
  });

  return {
    text: renderGrokText({
      text: canonicalText,
      sourceAttribution,
      options: sourceAttributionOptions
    }),
    sourceAttribution: createSourceAttributionPayload({
      sourceAttribution,
      options: sourceAttributionOptions
    }),
    options: sourceAttributionOptions
  };
}
