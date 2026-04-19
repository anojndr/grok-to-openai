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

  const output = [];
  let cursor = 0;
  let searchStart = 0;
  let removedAny = false;

  for (const fragment of fragments) {
    const index = streamedText.indexOf(fragment, searchStart);
    if (index === -1) {
      continue;
    }

    removedAny = true;
    if (index > cursor) {
      output.push(streamedText.slice(cursor, index));
    }

    cursor = index + fragment.length;
    searchStart = cursor;
  }

  if (!removedAny) {
    return streamedText;
  }

  if (cursor < streamedText.length) {
    output.push(streamedText.slice(cursor));
  }

  const strippedText = output.join("");
  return strippedText.trim() ? strippedText : streamedText;
}

function resolveCanonicalText(state) {
  const streamedVisibleText = state?.assistantVisibleText || "";
  const streamedText = state?.assistantText || "";
  const message = state?.modelResponse?.message;

  if (typeof message === "string" && message.trim()) {
    return message;
  }

  if (state?.modelResponse) {
    return stripStepTextFromStream(streamedText, state?.modelResponse);
  }

  return streamedVisibleText;
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
