export const GROK_46_BETA_MODE_ID = "grok-420-computer-use-sa";

const MODELS = [
  {
    id: "grok-4.6-auto",
    modeId: "auto",
    object: "model",
    owned_by: "xai-web"
  },
  {
    id: "grok-4.6-fast",
    modeId: "fast",
    object: "model",
    owned_by: "xai-web"
  },
  {
    id: "grok-4.6-expert",
    modeId: "expert",
    object: "model",
    owned_by: "xai-web"
  },
  {
    id: "grok-4.6-heavy",
    modeId: "heavy",
    object: "model",
    owned_by: "xai-web"
  },
  {
    id: "grok-4.6-beta",
    modeId: GROK_46_BETA_MODE_ID,
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

  ["grok-4.6", "auto"],
  ["grok-4.6-auto", "auto"],
  ["grok-4.6-fast", "fast"],
  ["grok-4.6-expert", "expert"],
  ["grok-4.6-heavy", "heavy"],
  ["grok-4.6-beta", GROK_46_BETA_MODE_ID],
  ["grok-4-6", "auto"],
  ["grok-4-6-beta", GROK_46_BETA_MODE_ID],
  ["grok 4.6", "auto"],
  ["grok 4.6 beta", GROK_46_BETA_MODE_ID],
  ["grok 4.6 (beta)", GROK_46_BETA_MODE_ID],
  ["grok-420-computer-use-sa", GROK_46_BETA_MODE_ID],
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
  const normalized = (requestedModel || fallbackModel || "grok-4.6-auto").toLowerCase();
  const explicitMode = aliasToMode.get(normalized) || inferModeFromModelName(normalized);

  if (explicitMode) {
    return {
      publicModel: requestedModel || fallbackModel || "grok-4.6-auto",
      grokModeId: explicitMode
    };
  }

  if (reasoningEffort === "high") {
    return {
      publicModel: requestedModel || fallbackModel || "grok-4.6-expert",
      grokModeId: "expert"
    };
  }

  return {
    publicModel: requestedModel || fallbackModel || "grok-4.6-auto",
    grokModeId: "auto"
  };
}

export function listModels() {
  return MODELS;
}

