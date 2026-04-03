export function getStreamingTextSuffix(fullText, emittedText) {
  if (!fullText) {
    return "";
  }

  if (!emittedText) {
    return fullText;
  }

  if (fullText.startsWith(emittedText)) {
    return fullText.slice(emittedText.length);
  }

  return "";
}
