import { resolveModel } from "./model-map.js";
import { GROK_SESSION_BLOCKED_ERROR_CODE } from "./browser-session.js";

const FAST_FALLBACK_MODEL = "grok-4-fast";

export function shouldFallbackToFast(publicModel) {
  const { grokModeId } = resolveModel(publicModel, undefined, publicModel);
  return (
    grokModeId === "auto" ||
    grokModeId === "expert" ||
    grokModeId === "heavy"
  );
}

export async function withFastModelFallback({ publicModel, operation }) {
  try {
    return await operation(publicModel);
  } catch (error) {
    if (
      !shouldFallbackToFast(publicModel) ||
      error?.details?.code === GROK_SESSION_BLOCKED_ERROR_CODE
    ) {
      throw error;
    }

    return operation(FAST_FALLBACK_MODEL);
  }
}
