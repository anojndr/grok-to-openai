import { sanitizeGrokMarkup } from "./markup.js";

function normalizeThoughtBlock(text) {
  let output = sanitizeGrokMarkup(text ?? "");
  output = output.replace(/[ \t]+\n/g, "\n");
  output = output.replace(/\n{3,}/g, "\n\n");
  return output.trim();
}

function normalizeMetadataMode(mode) {
  return typeof mode === "string" ? mode.trim().toLowerCase() : "";
}

function normalizeMetadataEffort(effort) {
  return typeof effort === "string" ? effort.trim().toLowerCase() : "";
}

export function shouldSuppressGrokThought(modelResponse = null) {
  const modes = [
    modelResponse?.requestMetadata?.mode,
    modelResponse?.metadata?.request_metadata?.mode
  ]
    .map(normalizeMetadataMode)
    .filter(Boolean);

  if (modes.some((mode) => mode.includes("expert") || mode.includes("heavy"))) {
    return true;
  }

  const efforts = [
    modelResponse?.requestMetadata?.effort,
    modelResponse?.metadata?.request_metadata?.effort
  ]
    .map(normalizeMetadataEffort)
    .filter(Boolean);

  if (efforts.includes("high")) {
    return true;
  }

  return Boolean(
    modelResponse?.uiLayout?.willThinkLong ??
      modelResponse?.metadata?.ui_layout?.willThinkLong
  );
}

export function renderGrokThought(modelResponse = null) {
  const sections = [];
  const seen = new Set();

  for (const step of modelResponse?.steps ?? []) {
    if (step?.tags?.includes("tool_usage_card")) {
      continue;
    }

    const combinedText = (step?.text ?? [])
      .filter((fragment) => typeof fragment === "string")
      .join("");
    const section = normalizeThoughtBlock(combinedText);

    if (!section || seen.has(section)) {
      continue;
    }

    seen.add(section);
    sections.push(section);
  }

  return sections.join("\n\n").trim();
}

export function renderThoughtAndResponse({
  thoughtText = "",
  responseText = ""
}) {
  const thought = (thoughtText ?? "").trim();
  const response = (responseText ?? "").trim();

  if (!thought) {
    return responseText;
  }

  if (!response) {
    return `${thought}\n\n**thought complete**`;
  }

  return `${thought}\n\n**thought complete**\n\n${response}`;
}

export function createThoughtAndResponseStreamDeltas({
  thoughtText = "",
  responseText = ""
}) {
  const thought = (thoughtText ?? "").trim();

  if (!thought) {
    return responseText ? [responseText] : [];
  }

  const deltas = [thought, "\n\n**thought complete**"];
  if (responseText) {
    deltas[deltas.length - 1] += "\n\n";
    deltas.push(responseText);
  }

  return deltas;
}
