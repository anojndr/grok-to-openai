import { createId } from "../lib/ids.js";
import { HttpError } from "../lib/errors.js";
import { BrowserSession } from "./browser-session.js";
import { normalizeFileForGrokUpload } from "./file-upload.js";
import {
  applyGrokEvent,
  collectGrokStreamingState,
  createNdjsonParser
} from "./stream-parser.js";
import { resolveModel } from "./model-map.js";

const DEVICE_ENV_INFO = Object.freeze({
  darkModeEnabled: false,
  devicePixelRatio: 1,
  screenWidth: 1920,
  screenHeight: 1080,
  viewportWidth: 1280,
  viewportHeight: 720
});

function makeDeviceEnvInfo() {
  return DEVICE_ENV_INFO;
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isAssistantSender(sender) {
  return typeof sender === "string" && sender.toLowerCase() === "assistant";
}

const DEFAULT_RESPONSE_HYDRATION_DELAYS_MS = Object.freeze([
  0,
  250,
  500,
  1000,
  2000,
  4000
]);

const DEFAULT_THINKING_RESPONSE_HYDRATION_DELAYS_MS = Object.freeze([
  ...DEFAULT_RESPONSE_HYDRATION_DELAYS_MS,
  8000,
  15000,
  ...Array.from({ length: 11 }, () => 30000)
]);

function normalizeHydrationDelays(delays, fallback) {
  if (!Array.isArray(delays) || delays.length === 0) {
    return fallback;
  }

  const normalized = delays
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);

  return normalized.length ? normalized : fallback;
}

function hasCompleteAssistantPayload(response) {
  if (!response || typeof response !== "object" || !isAssistantSender(response.sender)) {
    return false;
  }

  if (response.partial === false) {
    return true;
  }

  if (typeof response.message === "string" && response.message.trim()) {
    return true;
  }

  if ((response.generatedImageUrls ?? []).length > 0) {
    return true;
  }

  return (response.cardAttachmentsJson ?? []).length > 0;
}

function hasRenderableAssistantPayload(response) {
  if (!response || typeof response !== "object") {
    return false;
  }

  if (typeof response.message === "string" && response.message.trim()) {
    return true;
  }

  if ((response.generatedImageUrls ?? []).length > 0) {
    return true;
  }

  return (response.cardAttachmentsJson ?? []).length > 0;
}

function getModelResponseStreamErrors(response) {
  const messages = new Set();
  const streamErrors = [
    ...(Array.isArray(response?.streamErrors) ? response.streamErrors : []),
    ...(Array.isArray(response?.metadata?.stream_errors)
      ? response.metadata.stream_errors
      : [])
  ];

  for (const streamError of streamErrors) {
    const message =
      typeof streamError?.message === "string" ? streamError.message.trim() : "";
    if (message) {
      messages.add(message);
    }
  }

  return [...messages];
}

function inferModelResponseErrorStatus(message = "") {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("resourceexhausted") ||
    normalized.includes("admission denied") ||
    normalized.includes("load_shed") ||
    normalized.includes("overload") ||
    normalized.includes("unavailable")
  ) {
    return 503;
  }

  return 502;
}

function getModelResponseFailure(state) {
  const modelResponse = state?.modelResponse;
  if (!modelResponse || hasRenderableAssistantPayload(modelResponse)) {
    return null;
  }

  const streamErrors = getModelResponseStreamErrors(modelResponse);
  if (!streamErrors.length) {
    return null;
  }

  const message = streamErrors[0];
  const status = inferModelResponseErrorStatus(message);

  return new HttpError(status, `Grok request failed: ${message}`, {
    code: status === 503 ? "server_overloaded" : "upstream_error",
    streamErrors
  });
}

export class GrokClient {
  constructor(config) {
    this.config = config;
    this.browser = new BrowserSession(config);
  }

  async uploadFile({ filename, mimeType, bytes }) {
    const normalizedFile = normalizeFileForGrokUpload({
      filename,
      mimeType,
      bytes
    });
    const requestId = createId("grokreq");
    const body = {
      fileName: normalizedFile.filename,
      fileMimeType: normalizedFile.mimeType || "application/octet-stream",
      content: normalizedFile.bytes.toString("base64"),
      fileSource: "SELF_UPLOAD_FILE_SOURCE"
    };

    const response = await this.browser.request({
      requestId,
      url: `${this.config.grokBaseUrl}/rest/app-chat/upload-file`,
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json"
      }
    });

    if (!response.meta || response.meta.status >= 400) {
      throw new HttpError(
        response.meta?.status || 502,
        `Grok file upload failed: ${response.text || "unknown error"}`
      );
    }

    return JSON.parse(response.text);
  }

  async createConversationAndRespond({
    instructions,
    model,
    message,
    fileAttachments,
    onToken
  }) {
    const { publicModel, grokModeId } = resolveModel(
      model,
      undefined,
      this.config.defaultModel
    );

    return this.streamRequest({
      path: "/rest/app-chat/conversations/new",
      model: publicModel,
      onToken,
      body: {
        message,
        temporary: false,
        fileAttachments,
        imageAttachments: [],
        disableSearch: false,
        enableImageGeneration: true,
        returnImageBytes: false,
        returnRawGrokInXaiRequest: false,
        enableImageStreaming: true,
        imageGenerationCount: 2,
        forceConcise: false,
        enableSideBySide: true,
        sendFinalMetadata: true,
        disableTextFollowUps: false,
        disableMemory: false,
        forceSideBySide: false,
        isAsyncChat: false,
        disableSelfHarmShortCircuit: false,
        collectionIds: [],
        connectors: [],
        searchAllConnectors: false,
        deviceEnvInfo: makeDeviceEnvInfo(),
        modeId: grokModeId,
        customInstructions: instructions || undefined
      }
    });
  }

  async addResponse({
    conversationId,
    parentResponseId,
    instructions,
    model,
    message,
    fileAttachments,
    onToken
  }) {
    const { publicModel, grokModeId } = resolveModel(
      model,
      undefined,
      this.config.defaultModel
    );

    return this.streamRequest({
      path: `/rest/app-chat/conversations/${conversationId}/responses`,
      model: publicModel,
      onToken,
      body: {
        message,
        parentResponseId,
        fileAttachments,
        imageAttachments: [],
        disableSearch: false,
        enableImageGeneration: true,
        returnImageBytes: false,
        returnRawGrokInXaiRequest: false,
        enableImageStreaming: true,
        imageGenerationCount: 2,
        forceConcise: false,
        enableSideBySide: true,
        sendFinalMetadata: true,
        disableTextFollowUps: false,
        disableMemory: false,
        forceSideBySide: false,
        isAsyncChat: false,
        skipCancelCurrentInflightRequests: true,
        disableSelfHarmShortCircuit: false,
        collectionIds: [],
        connectors: [],
        searchAllConnectors: false,
        deviceEnvInfo: makeDeviceEnvInfo(),
        modeId: grokModeId,
        customInstructions: instructions || undefined
      }
    });
  }

  async createConversation() {
    const requestId = createId("grokreq");
    const response = await this.browser.request({
      requestId,
      url: `${this.config.grokBaseUrl}/rest/app-chat/conversations`,
      method: "POST",
      body: {
        temporary: false
      },
      headers: {
        "Content-Type": "application/json"
      }
    });

    if (!response.meta || response.meta.status >= 400) {
      throw new HttpError(
        response.meta?.status || 502,
        `Grok conversation creation failed: ${response.text || "unknown error"}`
      );
    }

    return JSON.parse(response.text);
  }

  async addUserResponse({ conversationId, parentResponseId, message }) {
    return this.jsonRequest({
      path: `/rest/app-chat/conversations/${conversationId}/user-responses`,
      body: {
        message,
        parentResponseId
      }
    });
  }

  async addModelResponse({ conversationId, parentResponseId, message }) {
    return this.jsonRequest({
      path: `/rest/app-chat/conversations/${conversationId}/model-responses`,
      body: {
        message,
        parentResponseId,
        partial: false
      }
    });
  }

  async jsonRequest({ path: relativePath, body }) {
    return this.requestJson({
      path: relativePath,
      method: "POST",
      body
    });
  }

  async requestJson({
    path: relativePath,
    method = "GET",
    body = null
  }) {
    const requestId = createId("grokreq");
    const response = await this.browser.request({
      requestId,
      url: `${this.config.grokBaseUrl}${relativePath}`,
      method,
      body,
      headers: {
        "Content-Type": "application/json"
      }
    });

    if (!response.meta || response.meta.status >= 400) {
      throw new HttpError(
        response.meta?.status || 502,
        `Grok request failed: ${response.text || "unknown error"}`
      );
    }

    return JSON.parse(response.text);
  }

  extractConversationIdFromPath(relativePath) {
    const match = /\/rest\/app-chat\/conversations\/([^/]+)/.exec(relativePath);
    return match?.[1] ?? null;
  }

  async findAssistantResponse({
    conversationId,
    userResponseId
  }) {
    if (!conversationId || !userResponseId) {
      return null;
    }

    const responseTree = await this.requestJson({
      path: `/rest/app-chat/conversations/${conversationId}/response-node?includeThreads=true`
    });
    const assistantResponseId = (responseTree?.responseNodes ?? [])
      .filter(
        (node) =>
          node?.parentResponseId === userResponseId &&
          isAssistantSender(node?.sender)
      )
      .at(-1)?.responseId;

    if (!assistantResponseId) {
      return null;
    }

    const loadedResponses = await this.requestJson({
      path: `/rest/app-chat/conversations/${conversationId}/load-responses`,
      method: "POST",
      body: {
        responseIds: [assistantResponseId]
      }
    });

    const assistantResponse = (
      (loadedResponses?.responses ?? []).find(
        (response) => response?.responseId === assistantResponseId
      ) ?? null
    );

    return hasCompleteAssistantPayload(assistantResponse) ? assistantResponse : null;
  }

  async loadAssistantResponseById({
    conversationId,
    responseId
  }) {
    if (!conversationId || !responseId) {
      return null;
    }

    const loadedResponses = await this.requestJson({
      path: `/rest/app-chat/conversations/${conversationId}/load-responses`,
      method: "POST",
      body: {
        responseIds: [responseId]
      }
    });

    const assistantResponse = (
      (loadedResponses?.responses ?? []).find(
        (response) => response?.responseId === responseId
      ) ?? null
    );

    return hasCompleteAssistantPayload(assistantResponse) ? assistantResponse : null;
  }

  getResponseHydrationDelays(state) {
    const thinkingOnly = state?.sawThinkingToken === true && state?.sawVisibleToken !== true;

    if (thinkingOnly) {
      return normalizeHydrationDelays(
        this.config.responseHydrationThinkingDelaysMs,
        DEFAULT_THINKING_RESPONSE_HYDRATION_DELAYS_MS
      );
    }

    return normalizeHydrationDelays(
      this.config.responseHydrationDelaysMs,
      DEFAULT_RESPONSE_HYDRATION_DELAYS_MS
    );
  }

  async hydrateMissingModelResponse({
    relativePath,
    state
  }) {
    if (state?.modelResponse) {
      return;
    }

    const conversationId =
      state?.conversation?.conversationId ??
      this.extractConversationIdFromPath(relativePath);
    if (!conversationId) {
      return;
    }

    const assistantResponseId = state?.assistantResponseId ?? null;
    const userResponseId = state?.userResponse?.responseId ?? null;
    if (!assistantResponseId && !userResponseId) {
      return;
    }

    const hydrationDelays = this.getResponseHydrationDelays(state);

    for (const delayMs of hydrationDelays) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }

      let assistantResponse;
      try {
        if (assistantResponseId) {
          assistantResponse = await this.loadAssistantResponseById({
            conversationId,
            responseId: assistantResponseId
          });
        }

        if (!assistantResponse && userResponseId) {
          assistantResponse = await this.findAssistantResponse({
            conversationId,
            userResponseId
          });
        }
      } catch {
        continue;
      }

      if (!assistantResponse) {
        continue;
      }

      state.modelResponse = assistantResponse;
      if (!state.assistantResponseId && assistantResponse.responseId) {
        state.assistantResponseId = assistantResponse.responseId;
      }
      if (!state.assistantText && assistantResponse.message) {
        state.assistantText = assistantResponse.message;
      }
      if (!state.assistantVisibleText && assistantResponse.message) {
        state.assistantVisibleText = assistantResponse.message;
      }
      return;
    }
  }

  async streamRequest({ path: relativePath, body, model, onToken = null }) {
    const requestId = createId("grokreq");
    const state = collectGrokStreamingState();

    const parser = createNdjsonParser((payload) => {
      const delta = applyGrokEvent(state, payload);
      if (delta?.type === "token" && delta.token) {
        onToken?.(delta.token, delta);
      }
    });

    const response = await this.browser.request({
      requestId,
      url: `${this.config.grokBaseUrl}${relativePath}`,
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json"
      },
      onChunk: parser
    });

    parser.flush();

    if (!response.meta || response.meta.status >= 400) {
      throw new HttpError(
        response.meta?.status || 502,
        `Grok request failed: ${response.text || "unknown error"}`
      );
    }

    await this.hydrateMissingModelResponse({
      relativePath,
      state
    });

    const modelResponseFailure = getModelResponseFailure(state);
    if (modelResponseFailure) {
      throw modelResponseFailure;
    }

    if (!state.modelResponse && state.sawThinkingToken && !state.sawVisibleToken) {
      throw new HttpError(
        502,
        "Grok ended the stream before the final assistant response was available"
      );
    }

    return {
      model,
      state
    };
  }

  async fetchAssetAsBase64(url) {
    return this.browser.fetchBase64(url);
  }

  async fetchAsset(url) {
    return this.browser.fetchAsset(url);
  }

  async close() {
    await this.browser.close();
  }
}
