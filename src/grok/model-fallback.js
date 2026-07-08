import { GROK_45_BETA_MODE_ID, resolveModel } from "./model-map.js";
import { GROK_SESSION_BLOCKED_ERROR_CODE } from "./browser-session.js";

const FAST_FALLBACK_MODEL = "grok-4.5-fast";

export function shouldFallbackToFast(publicModel) {
  const { grokModeId } = resolveModel(publicModel, undefined, publicModel);
  return (
    grokModeId === "auto" ||
    grokModeId === "expert" ||
    grokModeId === "heavy" ||
    grokModeId === GROK_45_BETA_MODE_ID
  );
}

export async function withFastModelFallback({ publicModel, operation, onToken }) {
  let hasEmittedTokens = false;
  const wrappedOnToken = onToken
    ? (token, meta) => {
        hasEmittedTokens = true;
        return onToken(token, meta);
      }
    : null;

  const retryDelayMs = process.env.MODEL_TIMEOUT_RETRY_DELAY_MS
    ? Number(process.env.MODEL_TIMEOUT_RETRY_DELAY_MS)
    : 2000;

  const runWithRetry = async (model) => {
    try {
      return await operation(model, wrappedOnToken);
    } catch (error) {
      const isTimeout =
        error &&
        String(error.message || "")
          .toLowerCase()
          .includes("timed out");

      if (isTimeout && !hasEmittedTokens) {
        if (retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
        return await operation(model, wrappedOnToken);
      }
      throw error;
    }
  };

  try {
    return await runWithRetry(publicModel);
  } catch (error) {
    if (
      hasEmittedTokens ||
      !shouldFallbackToFast(publicModel) ||
      error?.details?.code === GROK_SESSION_BLOCKED_ERROR_CODE
    ) {
      throw error;
    }

    return await runWithRetry(FAST_FALLBACK_MODEL);
  }
}
