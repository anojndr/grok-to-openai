import { sanitizeGrokMarkup } from "./markup.js";

function normalizeThoughtBlock(text) {
  let output = sanitizeGrokMarkup(text ?? "");
  output = output.replace(/[ \t]+\n/g, "\n");
  output = output.replace(/\n{3,}/g, "\n\n");
  return output.trim();
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
