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

function looksLikeDirectAssistantResponse(response) {
  if (!response || typeof response !== "object" || response.modelResponse) {
    return false;
  }

  if (!response.responseId) {
    return false;
  }

  if (typeof response.sender === "string") {
    return response.sender.toLowerCase() === "assistant";
  }

  return typeof response.message === "string" && Array.isArray(response.steps);
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
      token: response.token,
      isThinking: response.isThinking === true,
      messageTag: response.messageTag ?? null,
      messageStepId: response.messageStepId ?? null,
      responseId: response.responseId ?? null,
      rolloutId: response.rolloutId ?? null
    };
  }

  if (response.finalMetadata) {
    state.finalMetadata = response.finalMetadata;
  }

  const modelResponse = response.modelResponse ?? (
    looksLikeDirectAssistantResponse(response) ? response : null
  );

  if (modelResponse) {
    state.modelResponse = modelResponse;
    if (modelResponse.message && !state.assistantText) {
      state.assistantText = modelResponse.message;
    }
  }

  return null;
}
