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
  }
];

const aliasToMode = new Map([
  ["auto", "auto"],
  ["fast", "fast"],
  ["expert", "expert"],
  ["grok-4", "auto"],
  ["grok-4-auto", "auto"],
  ["grok-4-fast", "fast"],
  ["grok-4-expert", "expert"],
  ["grok-latest", "auto"],
  ["gpt-4o", "auto"],
  ["gpt-4.1", "auto"],
  ["gpt-5", "auto"]
]);

export function resolveModel(requestedModel, reasoningEffort, fallbackModel) {
  const normalized = (requestedModel || fallbackModel || "grok-4-auto").toLowerCase();
  const explicitMode = aliasToMode.get(normalized);

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
