import {
  createSourceAttributionPayload,
  extractSourceAttribution,
  renderGrokText,
  resolveSourceAttributionOptions
} from "./source-attribution.js";
import { extractGeneratedImages } from "./generated-images.js";

export function buildAssistantOutput(
  state,
  sourceAttributionRequest,
  options = {}
) {
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
    images: extractGeneratedImages({
      assistantText: streamedText || canonicalText,
      modelResponse: state?.modelResponse ?? null,
      grokBaseUrl: options.grokBaseUrl
    }),
    sourceAttribution: createSourceAttributionPayload({
      sourceAttribution,
      options: sourceAttributionOptions
    }),
    options: sourceAttributionOptions
  };
}
