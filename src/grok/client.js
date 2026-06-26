import { createId } from "../lib/ids.js";
import { HttpError } from "../lib/errors.js";
import {
  BrowserSession,
  GROK_SESSION_BLOCKED_ERROR_CODE
} from "./browser-session.js";
import { normalizeFileForGrokUpload } from "./file-upload.js";
import {
  applyGrokEvent,
  collectGrokStreamingState,
  createNdjsonParser
} from "./stream-parser.js";
import {
  hasCompleteAssistantPayload as hasCompleteAssistantPayloadValue,
  hasRenderableAssistantPayload
} from "./assistant-payload.js";
import { resolveModel, GROK_43_BETA_MODE_ID } from "./model-map.js";

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

const DEFAULT_FILE_UPLOAD_RETRY_DELAYS_MS = Object.freeze([
  0,
  500,
  1500,
  3000,
  5000
]);

function isCloudflareErrorText(text = "") {
  const normalized = String(text).toLowerCase();

  return (
    normalized.includes("attention required! | cloudflare") ||
    normalized.includes("sorry, you have been blocked") ||
    normalized.includes("checking if the site connection is secure") ||
    normalized.includes("cf-error-details") ||
    normalized.includes("cloudflare ray id")
  );
}

function isCloudflareResponse(response) {
  return isCloudflareErrorText(response?.text || "");
}

function isStorageExhaustedResponse(response) {
  const text = response?.text || "";
  return (
    response?.meta?.status >= 400 &&
    (text.includes("storage-exhausted") ||
      text.includes("storage allowance") ||
      text.includes("User exceeds their storage allowance"))
  );
}

function isTransientUploadResponse(response) {
  const status = response?.meta?.status || 0;

  return (
    isCloudflareResponse(response) ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

function isTransientUploadError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();

  return (
    error?.details?.code === GROK_SESSION_BLOCKED_ERROR_CODE ||
    normalized.includes("failed to fetch") ||
    normalized.includes("networkerror") ||
    normalized.includes("execution context was destroyed") ||
    normalized.includes("target closed") ||
    normalized.includes("target page, context or browser has been closed") ||
    normalized.includes("browsercontext.newpage") ||
    normalized.includes("target.createtarget") ||
    normalized.includes("failed to open a new tab")
  );
}

function throwGrokHttpError(prefix, response) {
  const status = response.meta?.status || 502;
  const text = response.text || "unknown error";

  if (isCloudflareErrorText(text)) {
    throw new HttpError(
      502,
      `${prefix}: Grok session was blocked by Cloudflare`,
      {
        code: GROK_SESSION_BLOCKED_ERROR_CODE,
        upstreamStatus: status
      }
    );
  }

  throw new HttpError(status, `${prefix}: ${text}`);
}

async function recoverFromUploadChallenge(browser, attempt) {
  if (attempt >= 2 && typeof browser.recreateContext === "function") {
    await browser.recreateContext();
    return;
  }

  if (typeof browser.recreatePage === "function") {
    await browser.recreatePage();
  }
}

async function recoverFromUploadError(browser, error, attempt) {
  if (
    error?.details?.code === GROK_SESSION_BLOCKED_ERROR_CODE &&
    typeof browser.recreateContext === "function"
  ) {
    await browser.recreateContext();
    return;
  }

  await recoverFromUploadChallenge(browser, attempt);
}

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

function hasCompleteAssistantResponse(response) {
  if (!response || typeof response !== "object" || !isAssistantSender(response.sender)) {
    return false;
  }

  return hasCompleteAssistantPayloadValue(response);
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
    normalized.includes("unavailable") ||
    normalized.includes("server_error") ||
    normalized.includes("browsercontext.newpage") ||
    normalized.includes("target.createtarget") ||
    normalized.includes("failed to open a new tab")
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

    let response;
    const retryDelays = normalizeHydrationDelays(
      this.config.fileUploadRetryDelaysMs,
      DEFAULT_FILE_UPLOAD_RETRY_DELAYS_MS
    );
    let cleanedUpStorage = false;

    for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
      if (attempt > 0) {
        await sleep(retryDelays[attempt]);
      }

      try {
        response = await this.browser.request({
          requestId: attempt === 0 ? requestId : createId("grokreq"),
          url: `${this.config.grokBaseUrl}/rest/app-chat/upload-file`,
          method: "POST",
          body,
          headers: {
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json"
          }
        });
      } catch (error) {
        if (
          isTransientUploadError(error) &&
          attempt < retryDelays.length - 1
        ) {
          await recoverFromUploadError(this.browser, error, attempt + 1);
          continue;
        }

        throw error;
      }

      if (response && response.meta && response.meta.status >= 400) {
        if (isStorageExhaustedResponse(response) && !cleanedUpStorage) {
          cleanedUpStorage = true;
          await this.deleteOldestAssets(20);
          attempt = Math.max(-1, attempt - 1);
          continue;
        }
      }

      if (
        isTransientUploadResponse(response) &&
        attempt < retryDelays.length - 1
      ) {
        if (isCloudflareResponse(response)) {
          await recoverFromUploadChallenge(this.browser, attempt + 1);
        }
        continue;
      }

      break;
    }

    if (!response.meta || response.meta.status >= 400) {
      throwGrokHttpError("Grok file upload failed", response);
    }

    if (isCloudflareResponse(response)) {
      throwGrokHttpError("Grok file upload failed", response);
    }

    try {
      return JSON.parse(response.text);
    } catch (error) {
      throw new HttpError(
        502,
        "Grok file upload returned an invalid JSON response",
        {
          upstreamStatus: response.meta?.status || 200,
          cause: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }

  async deleteConversation(conversationId) {
    const requestId = createId("grokreq");
    const response = await this.browser.request({
      requestId,
      url: `${this.config.grokBaseUrl}/rest/app-chat/conversations/${conversationId}`,
      method: "DELETE",
      headers: {
        "Content-Type": "application/json"
      }
    });

    if (!response.meta || response.meta.status >= 400) {
      throwGrokHttpError("Grok conversation deletion failed", response);
    }
    return true;
  }

  async deleteOldestConversations(count = 20) {
    try {
      console.warn("Grok storage exhausted. Fetching conversations to prune...");
      const conversationsResponse = await this.requestJson({
        path: "/rest/app-chat/conversations?limit=50",
        method: "GET"
      });
      const list = conversationsResponse?.conversations ?? (Array.isArray(conversationsResponse) ? conversationsResponse : []);
      if (!list.length) {
        return;
      }
      const oldest = list.slice(-count);
      console.warn(`Pruning ${oldest.length} oldest conversations to free up storage space.`);
      for (const conv of oldest) {
        const id = conv?.conversationId;
        if (id) {
          await this.deleteConversation(id).catch(() => {});
        }
      }
    } catch (error) {
      console.warn("Failed to delete oldest conversations:", error);
    }
  }

  async deleteAsset(assetId) {
    const requestId = createId("grokreq");
    const response = await this.browser.request({
      requestId,
      url: `${this.config.grokBaseUrl}/rest/assets/${assetId}`,
      method: "DELETE",
      headers: {
        "Content-Type": "application/json"
      }
    });

    if (!response.meta || response.meta.status >= 400) {
      throwGrokHttpError("Grok asset deletion failed", response);
    }
    return true;
  }

  async deleteOldestAssets(count = 20) {
    try {
      console.warn("Grok storage exhausted. Fetching assets to prune...");
      const assetsResponse = await this.requestJson({
        path: "/rest/assets?pageSize=50&orderBy=ORDER_BY_LAST_USE_TIME",
        method: "GET"
      });
      const list = assetsResponse?.assets ?? (Array.isArray(assetsResponse) ? assetsResponse : []);
      if (!list.length) {
        return;
      }
      const oldest = list.slice(-count);
      console.warn(`Pruning ${oldest.length} oldest assets to free up storage space.`);
      for (const asset of oldest) {
        const id = asset?.assetId;
        if (id) {
          await this.deleteAsset(id).catch(() => {});
        }
      }
    } catch (error) {
      console.warn("Failed to delete oldest assets:", error);
    }
  }

  async createConversationAndRespond({
    instructions,
    model,
    message,
    fileAttachments = [],
    imageAttachments = [],
    onToken
  }) {
    const { publicModel, grokModeId } = resolveModel(
      model,
      undefined,
      this.config.defaultModel
    );

    const backendModeId = grokModeId;

    return this.streamRequest({
      path: "/rest/app-chat/conversations/new",
      model: publicModel,
      onToken,
      body: {
        temporary: false,
        message,
        fileAttachments,
        imageAttachments,
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
        responseMetadata: {},
        disableMemory: false,
        forceSideBySide: false,
        isAsyncChat: false,
        disableSelfHarmShortCircuit: false,
        collectionIds: [],
        disabledConnectorIds: [],
        deviceEnvInfo: makeDeviceEnvInfo(),
        modeId: backendModeId,
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
    fileAttachments = [],
    imageAttachments = [],
    onToken
  }) {
    const { publicModel, grokModeId } = resolveModel(
      model,
      undefined,
      this.config.defaultModel
    );

    const backendModeId = grokModeId;

    return this.streamRequest({
      path: `/rest/app-chat/conversations/${conversationId}/responses`,
      model: publicModel,
      onToken,
      body: {
        message,
        parentResponseId,
        disableSearch: false,
        enableImageGeneration: true,
        imageAttachments,
        returnImageBytes: false,
        returnRawGrokInXaiRequest: false,
        fileAttachments,
        enableImageStreaming: true,
        imageGenerationCount: 2,
        forceConcise: false,
        enableSideBySide: true,
        sendFinalMetadata: true,
        metadata: {
          request_metadata: {}
        },
        disableTextFollowUps: false,
        disableMemory: false,
        forceSideBySide: false,
        isAsyncChat: false,
        isRegenRequest: false,
        disableSelfHarmShortCircuit: false,
        collectionIds: [],
        disabledConnectorIds: [],
        deviceEnvInfo: makeDeviceEnvInfo(),
        modeId: backendModeId,
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
      throwGrokHttpError("Grok conversation creation failed", response);
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
      throwGrokHttpError("Grok request failed", response);
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

    return hasCompleteAssistantResponse(assistantResponse) ? assistantResponse : null;
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

    return hasCompleteAssistantResponse(assistantResponse) ? assistantResponse : null;
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
    if (hasCompleteAssistantPayloadValue(state?.modelResponse)) {
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
      throwGrokHttpError("Grok request failed", response);
    }

    await this.hydrateMissingModelResponse({
      relativePath,
      state
    });

    const modelResponseFailure = getModelResponseFailure(state);
    if (modelResponseFailure) {
      throw modelResponseFailure;
    }

    if (
      !hasRenderableAssistantPayload(state.modelResponse) &&
      state.sawThinkingToken &&
      !state.sawVisibleToken
    ) {
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
