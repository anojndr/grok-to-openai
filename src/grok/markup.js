const START_MARKERS = [
  {
    start: "<xai:tool_usage_card>",
    end: "</xai:tool_usage_card>"
  },
  {
    start: "<grok:render",
    end: "</grok:render>"
  }
];

const MAX_START_LENGTH = Math.max(...START_MARKERS.map((marker) => marker.start.length));

export function sanitizeGrokMarkup(text) {
  let output = text ?? "";

  output = output.replace(
    /<xai:tool_usage_card>[\s\S]*?<\/xai:tool_usage_card>/g,
    ""
  );
  output = output.replace(/<grok:render[\s\S]*?<\/grok:render>/g, "");
  output = output.replace(/[ \t]+\n/g, "\n");
  output = output.replace(/\n{3,}/g, "\n\n");

  return output.trim();
}

export function createGrokMarkupStreamSanitizer() {
  let buffer = "";
  let hidden = null;

  function consumeVisiblePrefix() {
    let output = "";

    while (buffer.length > 0) {
      if (hidden) {
        const endIndex = buffer.indexOf(hidden.end);
        if (endIndex === -1) {
          const keep = Math.max(hidden.end.length - 1, 0);
          buffer = keep > 0 ? buffer.slice(-keep) : "";
          return output;
        }

        buffer = buffer.slice(endIndex + hidden.end.length);
        hidden = null;
        continue;
      }

      let nextMarker = null;
      let nextIndex = -1;
      for (const marker of START_MARKERS) {
        const index = buffer.indexOf(marker.start);
        if (index !== -1 && (nextIndex === -1 || index < nextIndex)) {
          nextIndex = index;
          nextMarker = marker;
        }
      }

      if (!nextMarker) {
        const safeLength = Math.max(buffer.length - (MAX_START_LENGTH - 1), 0);
        if (safeLength === 0) {
          return output;
        }

        output += buffer.slice(0, safeLength);
        buffer = buffer.slice(safeLength);
        return output;
      }

      if (nextIndex > 0) {
        output += buffer.slice(0, nextIndex);
        buffer = buffer.slice(nextIndex);
      }

      if (!buffer.startsWith(nextMarker.start)) {
        return output;
      }

      buffer = buffer.slice(nextMarker.start.length);
      hidden = nextMarker;
    }

    return output;
  }

  return {
    write(chunk) {
      buffer += chunk;
      return consumeVisiblePrefix();
    },
    flush() {
      if (hidden) {
        return "";
      }

      const output = buffer;
      buffer = "";
      return output;
    }
  };
}
