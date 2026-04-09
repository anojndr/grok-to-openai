import {
  createSourceAttributionPayload,
  extractSourceAttribution,
  renderGrokText,
  resolveSourceAttributionOptions
} from "./source-attribution.js";
import { extractGeneratedImages } from "./generated-images.js";
import { renderGrokThought, shouldSuppressGrokThought } from "./thought.js";

function extractStepTextFragments(modelResponse) {
  const fragments = [];
  const seen = new Set();

  for (const step of modelResponse?.steps ?? []) {
    for (const fragment of step?.text ?? []) {
      if (typeof fragment !== "string" || !fragment || seen.has(fragment)) {
        continue;
      }

      seen.add(fragment);
      fragments.push(fragment);
    }
  }

  return fragments;
}

function stripStepTextFromStream(streamedText, modelResponse) {
  const fragments = extractStepTextFragments(modelResponse);
  if (!streamedText || !fragments.length) {
    return streamedText;
  }

  let output = streamedText;
  for (const fragment of fragments) {
    output = output.split(fragment).join("");
  }

  return output.trim() ? output : streamedText;
}

function resolveCanonicalText(state) {
  const streamedText = state?.assistantText || "";
  const message = state?.modelResponse?.message;

  if (typeof message === "string" && message.trim()) {
    return message;
  }

  return stripStepTextFromStream(streamedText, state?.modelResponse);
}

export function buildAssistantOutput(
  state,
  sourceAttributionRequest,
  options = {}
) {
  const streamedText = state?.assistantText || "";
  const canonicalText = resolveCanonicalText(state);
  const sourceAttributionOptions = resolveSourceAttributionOptions(
    sourceAttributionRequest
  );
  const rawThoughtText = renderGrokThought(state?.modelResponse ?? null);
  const sourceAttribution = extractSourceAttribution({
    assistantText: streamedText || canonicalText,
    modelResponse: state?.modelResponse ?? null
  });

  return {
    thoughtText: shouldSuppressGrokThought(state?.modelResponse ?? null)
      ? ""
      : rawThoughtText,
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
