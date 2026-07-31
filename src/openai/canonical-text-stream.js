export function createCanonicalTextStream({
  onActivity = null,
  onText = null
} = {}) {
  let activityEmitted = false;
  let finished = false;

  return {
    observe(token) {
      if (finished || !token || activityEmitted) {
        return;
      }

      activityEmitted = true;
      onActivity?.();
    },
    finish(text) {
      if (finished) {
        return "";
      }

      finished = true;
      const canonicalText = typeof text === "string" ? text : "";
      if (canonicalText) {
        onText?.(canonicalText);
      }

      return canonicalText;
    }
  };
}
