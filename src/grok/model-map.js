const MODELS = [
  {
    id: "grok-4-auto",
    modeId: "auto",
    object: "model",
    owned_by: "xai-web"
  },
  {
    id: "grok-4-fast",
    modeId: "fast",
    object: "model",
    owned_by: "xai-web"
  },
  {
    id: "grok-4-expert",
    modeId: "expert",
    object: "model",
    owned_by: "xai-web"
  },
  {
    id: "grok-4-heavy",
    modeId: "heavy",
    object: "model",
    owned_by: "xai-web"
  }
];

const aliasToMode = new Map([
  ["auto", "auto"],
  ["fast", "fast"],
  ["expert", "expert"],
  ["heavy", "heavy"],
  ["grok", "auto"],
  ["grok auto", "auto"],
  ["grok fast", "fast"],
  ["grok expert", "expert"],
  ["grok heavy", "heavy"],
  ["grok-auto", "auto"],
  ["grok-fast", "fast"],
  ["grok-expert", "expert"],
  ["grok-heavy", "heavy"],
  ["grok-4", "auto"],
  ["grok-4-auto", "auto"],
  ["grok-4-fast", "fast"],
  ["grok-4-expert", "expert"],
  ["grok-4-heavy", "heavy"],
  ["grok-3", "auto"],
  ["grok-3-auto", "auto"],
  ["grok-3-fast", "fast"],
  ["grok-3-expert", "expert"],
  ["grok-3-heavy", "heavy"],
  ["grok-latest", "auto"],
  ["gpt-4o", "auto"],
  ["gpt-4.1", "auto"],
  ["gpt-5", "auto"]
]);

function inferModeFromModelName(normalizedModel) {
  if (!normalizedModel) {
    return null;
  }

  if (/(\b|[-_ ])heavy(\b|[-_ ])/.test(normalizedModel)) {
    return "heavy";
  }

  if (/(\b|[-_ ])expert(\b|[-_ ])/.test(normalizedModel)) {
    return "expert";
  }

  if (/(\b|[-_ ])fast(\b|[-_ ])/.test(normalizedModel)) {
    return "fast";
  }

  if (/(\b|[-_ ])auto(\b|[-_ ])/.test(normalizedModel)) {
    return "auto";
  }

  return null;
}

export function resolveModel(requestedModel, reasoningEffort, fallbackModel) {
  const normalized = (requestedModel || fallbackModel || "grok-4-auto").toLowerCase();
  const explicitMode = aliasToMode.get(normalized) || inferModeFromModelName(normalized);

  if (explicitMode) {
    return {
      publicModel: requestedModel || fallbackModel || "grok-4-auto",
      grokModeId: explicitMode
    };
  }

  if (reasoningEffort === "high") {
    return {
      publicModel: requestedModel || fallbackModel || "grok-4-expert",
      grokModeId: "expert"
    };
  }

  return {
    publicModel: requestedModel || fallbackModel || "grok-4-auto",
    grokModeId: "auto"
  };
}

export function listModels() {
  return MODELS;
}
