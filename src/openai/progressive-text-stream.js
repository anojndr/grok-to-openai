import { createGrokMarkupStreamSanitizer } from "../grok/markup.js";

export function createProgressiveTextStream({
  onActivity = null,
  onText = null
} = {}) {
  let activityEmitted = false;
  let finished = false;
  const sanitizer = createGrokMarkupStreamSanitizer();
  let buffer = "";
  let bufferLength = 0;

  return {
    observe(token) {
      if (finished || typeof token !== "string" || !token) {
        return;
      }

      const visible = sanitizer.write(token);
      if (visible) {
        if (!activityEmitted) {
          activityEmitted = true;
          onActivity?.();
        }
        const normalized = visible
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n");
        buffer += normalized;
        bufferLength += normalized.length;
        onText?.(normalized);
      }
    },
    finish(fullText) {
      if (finished) {
        return "";
      }

      finished = true;
      const canonicalText = typeof fullText === "string" ? fullText : "";
      const exactLength = bufferLength === canonicalText.length;

      if (
        canonicalText &&
        (!exactLength || !canonicalText.startsWith(buffer))
      ) {
        if (!activityEmitted) {
          activityEmitted = true;
          onActivity?.();
        }
        onText?.(canonicalText);
      }

      return canonicalText;
    }
  };
}
