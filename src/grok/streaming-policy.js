import { resolveModel } from "./model-map.js";

const BUFFERED_MODES = new Set(["auto", "expert", "heavy"]);

export function shouldBufferReasoningStream({
  model,
  reasoningEffort,
  fallbackModel
} = {}) {
  if (reasoningEffort === "high") {
    return true;
  }

  const { grokModeId } = resolveModel(model, undefined, fallbackModel);
  return BUFFERED_MODES.has(grokModeId);
}
