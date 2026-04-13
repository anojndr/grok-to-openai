export function createTextAccumulator(initialText = "") {
  let cached = String(initialText ?? "");
  let chunks = cached ? [cached] : [];
  let length = cached.length;
  let dirty = false;

  return {
    append(chunk) {
      const text = String(chunk ?? "");
      if (!text) {
        return;
      }

      chunks.push(text);
      length += text.length;
      dirty = true;
    },
    set(text = "") {
      cached = String(text ?? "");
      chunks = cached ? [cached] : [];
      length = cached.length;
      dirty = false;
    },
    isEmpty() {
      return length === 0;
    },
    toString() {
      if (!dirty) {
        return cached;
      }

      cached = chunks.join("");
      chunks = cached ? [cached] : [];
      dirty = false;
      return cached;
    }
  };
}
