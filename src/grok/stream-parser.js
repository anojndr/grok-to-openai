import { HttpError } from "../lib/errors.js";
import { createTextAccumulator } from "../lib/text-accumulator.js";
import { hasUsableAssistantMessage } from "./assistant-payload.js";

const ASSISTANT_TEXT = Symbol("assistantText");
const ASSISTANT_VISIBLE_TEXT = Symbol("assistantVisibleText");

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
  const assistantText = createTextAccumulator();
  const assistantVisibleText = createTextAccumulator();
  const state = {
    conversation: null,
    userResponse: null,
    modelResponse: null,
    assistantResponseId: null,
    sawThinkingToken: false,
    sawVisibleToken: false,
    title: null,
    finalMetadata: null,
    uiLayout: null,
    llmInfo: null
  };

  Object.defineProperty(state, ASSISTANT_TEXT, {
    value: assistantText
  });
  Object.defineProperty(state, ASSISTANT_VISIBLE_TEXT, {
    value: assistantVisibleText
  });
  Object.defineProperty(state, "assistantText", {
    enumerable: true,
    get() {
      return assistantText.toString();
    },
    set(value) {
      assistantText.set(value);
    }
  });
  Object.defineProperty(state, "assistantVisibleText", {
    enumerable: true,
    get() {
      return assistantVisibleText.toString();
    },
    set(value) {
      assistantVisibleText.set(value);
    }
  });

  return state;
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
    if (typeof response.responseId === "string" && response.responseId) {
      state.assistantResponseId = response.responseId;
    }

    if (response.token.length === 0) {
      return null;
    }

    state[ASSISTANT_TEXT].append(response.token);
    if (response.isThinking === true) {
      state.sawThinkingToken = true;
    } else {
      state.sawVisibleToken = true;
      state[ASSISTANT_VISIBLE_TEXT].append(response.token);
    }

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
    if (typeof modelResponse.responseId === "string" && modelResponse.responseId) {
      state.assistantResponseId = modelResponse.responseId;
    }

    if (hasUsableAssistantMessage(modelResponse) && state[ASSISTANT_TEXT].isEmpty()) {
      state.assistantText = modelResponse.message;
    }
    if (
      hasUsableAssistantMessage(modelResponse) &&
      state[ASSISTANT_VISIBLE_TEXT].isEmpty()
    ) {
      state.assistantVisibleText = modelResponse.message;
    }
  }

  return null;
}
