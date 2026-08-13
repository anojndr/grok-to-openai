import { createGrokMarkupStreamSanitizer } from "../grok/markup.js";

export function createProgressiveTextStream({
  onActivity = null,
  onText = null
} = {}) {
  let activityEmitted = false;
  let finished = false;
  const sanitizer = createGrokMarkupStreamSanitizer();
  let buffer = "";

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
        onText?.(normalized);
      }
    },
    finish(fullText) {
      if (finished) {
        return "";
      }

      finished = true;
      const canonicalText = typeof fullText === "string" ? fullText : "";
      if (!canonicalText) {
        return "";
      }

      if (!buffer) {
        if (!activityEmitted) {
          activityEmitted = true;
          onActivity?.();
        }
        onText?.(canonicalText);
        return canonicalText;
      }

      if (canonicalText === buffer) {
        return canonicalText;
      }

      // Final SSE events carry the complete canonical message separately. Never
      // replay that message as a new delta: a citation or markup difference in
      // the canonical form must not duplicate the answer already delivered.
      // Only append an unambiguous suffix when the live stream is a prefix.
      if (!canonicalText.startsWith(buffer)) {
        return canonicalText;
      }

      const suffix = canonicalText.slice(buffer.length);
      if (suffix) {
        onText?.(suffix);
      }

      return canonicalText;
    }
  };
}
