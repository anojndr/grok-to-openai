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

    return (
      (loadedResponses?.responses ?? []).find(
        (response) => response?.responseId === assistantResponseId
      ) ?? null
    );
  }

  async hydrateMissingModelResponse({
    relativePath,
    state
  }) {
    if (state?.modelResponse || !state?.userResponse?.responseId) {
      return;
    }

    const conversationId =
      state?.conversation?.conversationId ??
      this.extractConversationIdFromPath(relativePath);
    if (!conversationId) {
      return;
    }

    for (const delayMs of [0, 250, 500, 1000, 2000, 4000]) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }

      let assistantResponse;
      try {
        assistantResponse = await this.findAssistantResponse({
          conversationId,
          userResponseId: state.userResponse.responseId
        });
      } catch {
        continue;
      }

      if (!assistantResponse) {
        continue;
      }

      state.modelResponse = assistantResponse;
      if (!state.assistantText && assistantResponse.message) {
        state.assistantText = assistantResponse.message;
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
