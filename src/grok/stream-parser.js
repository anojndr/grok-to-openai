import { HttpError } from "../lib/errors.js";

export function createNdjsonParser(onObject) {
  let buffer = "";

  const parser = (chunk) => {
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

  parser.flush = () => {
    const line = buffer.trim();
    buffer = "";

    if (!line) {
      return;
    }

    onObject(JSON.parse(line));
  };

  return parser;
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

  // Grok emits two closely related streaming shapes:
  // - `/conversations/new`: response details nested under `result.response`
  // - follow-up `/conversations/:id/responses`: response details at `result.*`
  const response = result.response ?? result;

  if (result.conversation) {
    state.conversation = result.conversation;
  }

  if (result.title?.newTitle) {
    state.title = result.title.newTitle;
  }

  if (response.userResponse) {
    state.userResponse = response.userResponse;
  }

  if (response.uiLayout) {
    state.uiLayout = response.uiLayout;
  }

  if (response.llmInfo) {
    state.llmInfo = response.llmInfo;
  }

  if (typeof response.token === "string") {
    state.assistantText += response.token;
    return {
      type: "token",
      token: response.token
    };
  }

  if (response.finalMetadata) {
    state.finalMetadata = response.finalMetadata;
  }

  if (response.modelResponse) {
    state.modelResponse = response.modelResponse;
    if (response.modelResponse.message && !state.assistantText) {
      state.assistantText = response.modelResponse.message;
    }
  }

  return null;
}
