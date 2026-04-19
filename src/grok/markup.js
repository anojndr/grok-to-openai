const START_MARKERS = [
  {
    kind: "tool",
    start: "<xai:tool_usage_card>",
    end: "</xai:tool_usage_card>"
  },
  {
    kind: "render",
    start: "<grok:render",
    end: "</grok:render>"
  }
];

const MAX_START_LENGTH = Math.max(...START_MARKERS.map((marker) => marker.start.length));

function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit) {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function clampSplitIndex(text, index) {
  const bounded = Math.max(0, Math.min(index, text.length));
  if (bounded === 0 || bounded === text.length) {
    return bounded;
  }

  return (
    isHighSurrogate(text.charCodeAt(bounded - 1)) &&
    isLowSurrogate(text.charCodeAt(bounded))
  )
    ? bounded - 1
    : bounded;
}

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

export function createGrokMarkupStreamSanitizer(options = {}) {
  let buffer = "";
  let hidden = null;
  let halted = false;
  const stopAtRenderTag = options.stopAtRenderTag ?? false;

  function consumeVisiblePrefix() {
    const output = [];
    const appendOutput = (chunk) => {
      if (chunk) {
        output.push(chunk);
      }
    };
    const flushOutput = () => output.join("");

    while (!halted && buffer.length > 0) {
      if (hidden) {
        const endIndex = buffer.indexOf(hidden.end);
        if (endIndex === -1) {
          const keep = Math.max(hidden.end.length - 1, 0);
          buffer = keep > 0 ? buffer.slice(-keep) : "";
          return flushOutput();
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
          return flushOutput();
        }

        const splitIndex = clampSplitIndex(buffer, safeLength);
        if (splitIndex === 0) {
          return flushOutput();
        }

        appendOutput(buffer.slice(0, splitIndex));
        buffer = buffer.slice(splitIndex);
        return flushOutput();
      }

      if (nextIndex > 0) {
        appendOutput(buffer.slice(0, nextIndex));
        buffer = buffer.slice(nextIndex);
      }

      if (!buffer.startsWith(nextMarker.start)) {
        return flushOutput();
      }

      if (stopAtRenderTag && nextMarker.kind === "render") {
        halted = true;
        return flushOutput();
      }

      buffer = buffer.slice(nextMarker.start.length);
      hidden = nextMarker;
    }

    return flushOutput();
  }

  return {
    write(chunk) {
      buffer += chunk;
      if (halted) {
        return "";
      }
      return consumeVisiblePrefix();
    },
    flush() {
      if (hidden || halted) {
        return "";
      }

      const output = buffer;
      buffer = "";
      return output;
    }
  };
}
