import { HttpError } from "../lib/errors.js";

export function createNdjsonParser(onObject) {
  let buffer = "";

  return (chunk) => {
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      onObject(JSON.parse(line));
    }
  };
}

export function collectGrokStreamingState() {
  return {
    conversation: null,
    userResponse: null,
    modelResponse: null,
    assistantText: "",
    title: null,
    finalMetadata: null,
    uiLayout: null,
    llmInfo: null
  };
}

export function applyGrokEvent(state, payload) {
  if (payload.error) {
    throw new HttpError(502, payload.error.message || "Grok request failed", payload.error);
  }

  const result = payload.result;
  if (!result) {
    return null;
  }

  if (result.conversation) {
    state.conversation = result.conversation;
  }

  if (result.title?.newTitle) {
    state.title = result.title.newTitle;
  }

  if (result.response?.userResponse) {
    state.userResponse = result.response.userResponse;
  }

  if (result.response?.uiLayout) {
    state.uiLayout = result.response.uiLayout;
  }

  if (result.response?.llmInfo) {
    state.llmInfo = result.response.llmInfo;
  }

  if (typeof result.response?.token === "string") {
    state.assistantText += result.response.token;
    return {
      type: "token",
      token: result.response.token
    };
  }

  if (result.response?.finalMetadata) {
    state.finalMetadata = result.response.finalMetadata;
  }

  if (result.response?.modelResponse) {
    state.modelResponse = result.response.modelResponse;
    if (result.response.modelResponse.message && !state.assistantText) {
      state.assistantText = result.response.modelResponse.message;
    }
  }

  return null;
}
