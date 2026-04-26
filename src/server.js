import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import multer from "multer";
import { config } from "./config.js";
import { HttpError, toOpenAIError } from "./lib/errors.js";
import { ensureDir, sanitizeFilename } from "./lib/fs.js";
import { createStores } from "./store/index.js";
import {
  responsesCreateSchema
} from "./openai/schema.js";
import {
  normalizeConversationInput
} from "./openai/input.js";
import {
  prepareChatCompletionRequest,
  runPreparedChatCompletionRequest
} from "./openai/chat-completion-request.js";
import {
  buildConversationHistory,
  continueResponseConversation
} from "./openai/continuation.js";
import {
  createResponseEnvelope,
  createResponseImageOutputItem,
  createStreamingResponseSnapshot,
  hydrateResponseImageResults,
  stripImageResultsFromResponse
} from "./openai/response-object.js";
import {
  createChatCompletion,
  createChatCompletionChunk,
  renderChatCompletionContent
} from "./openai/chat-completions.js";
import { initSse, writeSseEvent } from "./openai/sse.js";
import { createId, unixTimestampSeconds } from "./lib/ids.js";
import { createTextAccumulator } from "./lib/text-accumulator.js";
import { createGrokMarkupStreamSanitizer } from "./grok/markup.js";
import { withFastModelFallback } from "./grok/model-fallback.js";
import { buildAssistantOutput } from "./grok/output.js";
import { ImgbbClient, rehostGeneratedImages } from "./imgbb/client.js";
import { listModels, resolveModel } from "./grok/model-map.js";
import {
  renderThoughtAndResponse
} from "./grok/thought.js";
import { buildStoredGrokState } from "./grok/response-state.js";
import { getStreamingTextSuffix } from "./openai/streaming-text.js";
import { GrokAccountPool } from "./grok/account-pool.js";
import {
  buildJsonBodyTooLargeMessage,
  buildUploadedFileTooLargeMessage,
  JSON_BODY_LIMIT,
  UPLOAD_FILE_SIZE_LIMIT
} from "./lib/request-limits.js";

const app = express();
const uploadTempDir = path.join(config.dataDir, "tmp-uploads");
await ensureDir(uploadTempDir);
const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      callback(null, uploadTempDir);
    },
    filename(_req, file, callback) {
      callback(
        null,
        `${createId("upload")}-${sanitizeFilename(file.originalname || "upload.bin")}`
      );
    }
  }),
  limits: {
    fileSize: UPLOAD_FILE_SIZE_LIMIT
  }
});

const {
  fileStore,
  responseStore,
  close: closeStores
} = await createStores(config);

const grokAccounts = new GrokAccountPool(config);
const imgbb = new ImgbbClient(config);

let server;
let shutdownPromise = null;

async function shutdown() {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    server?.close();
    await closeStores();
    await grokAccounts.close();
    process.exit(0);
  })();

  return shutdownPromise;
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

function maybeHandleStreamingError(req, res, error) {
  const contentType = res.getHeader("Content-Type");
  const isEventStream =
    typeof contentType === "string" &&
    contentType.includes("text/event-stream");

  if (!isEventStream || res.writableEnded) {
    return false;
  }

  const payload = toOpenAIError(error);

  if (req.path === "/v1/responses") {
    writeSseEvent(res, "error", {
      type: "error",
      error: payload.body.error
    });
    res.end();
    return true;
  }

  if (req.path === "/v1/chat/completions") {
    res.write(`data: ${JSON.stringify(payload.body)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return true;
  }

  return false;
}

app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", config.allowOrigins);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use((req, _res, next) => {
  if (!config.apiKey) {
    next();
    return;
  }

  const auth = req.get("authorization") || "";
  if (auth !== `Bearer ${config.apiKey}`) {
    next(new HttpError(401, "Invalid API key"));
    return;
  }

  next();
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: listModels()
  });
});

app.post("/v1/files", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new HttpError(400, "Missing file");
    }

    const purpose = req.body.purpose || "user_data";
    const record = await fileStore.createFromPath({
      filename: req.file.originalname,
      sourcePath: req.file.path,
      purpose,
      mimeType: req.file.mimetype,
      size: req.file.size
    });

    res.status(200).json(record);
  } catch (error) {
    if (maybeHandleStreamingError(req, res, error)) {
      return;
    }
    next(error);
  } finally {
    if (req.file?.path) {
      await fs.rm(req.file.path, { force: true }).catch(() => {});
    }
  }
});

app.get("/v1/files/:fileId", async (req, res, next) => {
  try {
    const file = await fileStore.get(req.params.fileId);
    if (!file) {
      throw new HttpError(404, "File not found");
    }

    res.json(file);
  } catch (error) {
    next(error);
  }
});

app.get("/v1/files/:fileId/content", async (req, res, next) => {
  try {
    const stored = await fileStore.getWithContent(req.params.fileId);
    if (!stored?.content || !stored.record) {
      throw new HttpError(404, "File not found");
    }

    res.setHeader("Content-Type", stored.record.mime_type || "application/octet-stream");
    res.send(stored.content);
  } catch (error) {
    next(error);
  }
});

app.get("/v1/responses/:responseId", async (req, res, next) => {
  try {
    const record = await responseStore.get(req.params.responseId);
    if (!record) {
      throw new HttpError(404, "Response not found");
    }

    const response = await hydrateResponseImageResults({
      response: record.response,
      history: record.history,
      fileStore
    });

    res.json(response);
  } catch (error) {
    next(error);
  }
});

async function uploadFilesToGrok(accountClient, files) {
  const uploaded = [];

  for (const file of files) {
    const upload = await accountClient.uploadFile({
      filename: file.filename,
      mimeType: file.mimeType,
      bytes: file.bytes
    });

    if (!upload?.fileMetadataId) {
      throw new HttpError(502, "Grok upload did not return a fileMetadataId");
    }

    uploaded.push(upload.fileMetadataId);
  }

  return uploaded;
}

async function executeConversationRequest({
  instructions,
  publicModel,
  message,
  files,
  onToken
}) {
  const result = await grokAccounts.withFallback(async (accountClient) => {
    const fileAttachments = await uploadFilesToGrok(accountClient, files);

    return withFastModelFallback({
      publicModel,
      async operation(model) {
        return accountClient.createConversationAndRespond({
          instructions,
          model,
          message,
          fileAttachments,
          onToken
        });
      }
    });
  });

  return {
    accountIndex: result.accountIndex,
    ...result.value
  };
}

function buildTranscriptPrompt(messages) {
  return messages
    .map((message) => {
      const role =
        message.role === "assistant"
          ? "Assistant"
          : message.role === "user"
            ? "User"
            : message.role;
      const attachmentSuffix =
        message.files.length > 0 ? `\n[Attachments: ${message.files.length}]` : "";
      return `${role}: ${message.text || ""}${attachmentSuffix}`.trim();
    })
    .join("\n\n");
}

async function executeManualHistory({
  messages,
  instructions,
  publicModel,
  onToken
}) {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "user") {
    throw new HttpError(400, "The final message must be a user message");
  }

  const priorMessages = messages.slice(0, -1);
  const transcript = buildTranscriptPrompt(priorMessages);
  const combinedMessage = transcript
    ? `${transcript}\n\nUser: ${lastMessage.text}\n\nRespond to the latest user message.`
    : lastMessage.text;

  return executeConversationRequest({
    instructions,
    publicModel,
    message: combinedMessage,
    files: lastMessage.files,
    onToken
  });
}

async function runResponseRequest(parsed, normalized, options = {}) {
  const onToken = options.onToken ?? null;
  const previousRecordOption = options.previousRecord;
  const loadPreviousHistoryOption = options.loadPreviousHistory ?? null;

  if (!normalized.messages.length) {
    throw new HttpError(400, "input must include at least one user message");
  }

  const { publicModel } = resolveModel(
    parsed.model,
    parsed.reasoning?.effort,
    config.defaultModel
  );

  if (parsed.conversation) {
    throw new HttpError(400, "conversation is not implemented; use previous_response_id");
  }

  if (parsed.previous_response_id) {
    const previous =
      previousRecordOption ??
      (await responseStore.get(parsed.previous_response_id));
    if (!previous) {
      throw new HttpError(404, `Unknown previous_response_id: ${parsed.previous_response_id}`);
    }

    return continueResponseConversation({
      previousRecord: previous,
      currentMessages: normalized.messages,
      instructions: normalized.instructions,
      publicModel,
      grokAccounts,
      uploadFilesToGrok,
      fileStore,
      onToken,
      loadPreviousHistory:
        loadPreviousHistoryOption ??
        (async () => {
          const record = await responseStore.getWithHistory(parsed.previous_response_id);
          return record?.history ?? null;
        })
    });
  }

  if (normalized.messages.length === 1 && normalized.messages[0].role === "user") {
    const message = normalized.messages[0];
    return executeConversationRequest({
      instructions: normalized.instructions,
      publicModel,
      message: message.text,
      files: message.files,
      onToken
    });
  }

  return executeManualHistory({
    messages: normalized.messages,
    instructions: normalized.instructions,
    publicModel,
    onToken
  });
}

async function runChatCompletionRequest(reqBody, options = {}) {
  return runPreparedChatCompletionRequest(reqBody, {
    executeConversationRequest,
    executeManualHistory,
    onToken: options.onToken ?? null
  });
}

function createStreamingSourceAttributionRequest(sourceAttribution) {
  if (sourceAttribution?.inline_citations === false) {
    return sourceAttribution;
  }

  return {
    ...(sourceAttribution ?? {}),
    inline_citations: false
  };
}

async function uploadImageToImgbb({
  filename,
  mimeType,
  bytes
}) {
  const hostedUrl = await imgbb.uploadFile({
    filename,
    mimeType,
    bytes
  });

  return imgbb.verifyFile(hostedUrl);
}

async function buildHostedAssistantOutput(
  state,
  sourceAttributionRequest,
  accountIndex
) {
  const assistantOutput = buildAssistantOutput(state, sourceAttributionRequest, {
    grokBaseUrl: config.grokBaseUrl
  });

  if (!assistantOutput.images.length) {
    return assistantOutput;
  }

  return {
    ...assistantOutput,
    images: await rehostGeneratedImages({
      images: assistantOutput.images,
      loadSourceImage: (image) =>
        grokAccounts.fetchAsset(image.url, {
          accountIndex
        }),
      uploadClient: {
        async uploadFile({ filename, mimeType, bytes }) {
          return uploadImageToImgbb({
            filename,
            mimeType,
            bytes
          });
        }
      }
    })
  };
}

app.post("/v1/responses", async (req, res, next) => {
  try {
    const requestBody = req.body;
    const responseId = createId("resp");
    const messageId = createId("msg");
    const parsed = responsesCreateSchema.parse(requestBody);
    const previousRecord = parsed.previous_response_id
      ? await responseStore.get(parsed.previous_response_id)
      : null;
    if (parsed.previous_response_id && !previousRecord) {
      throw new HttpError(404, `Unknown previous_response_id: ${parsed.previous_response_id}`);
    }
    const { publicModel } = resolveModel(
      parsed.model,
      parsed.reasoning?.effort,
      config.defaultModel
    );

    if (parsed.stream) {
      initSse(res);

      const normalized = await normalizeConversationInput({
        requestBody: parsed,
        fileStore,
        loadRemoteImageAsset: (url) => grokAccounts.fetchAsset(url)
      });
      const instructions = normalized.instructions;
      const snapshot = createStreamingResponseSnapshot({
        id: responseId,
        model: publicModel,
        instructions,
        previousResponseId: parsed.previous_response_id ?? null,
        metadata: parsed.metadata ?? {},
        request: parsed
      });

      const streamingSourceAttribution = createStreamingSourceAttributionRequest(
        parsed.source_attribution
      );
      const sanitizer = createGrokMarkupStreamSanitizer();
      const emittedText = createTextAccumulator();
      let emittedResponsePrelude = false;
      let emittedMessagePrelude = false;
      const emitResponsePrelude = () => {
        if (emittedResponsePrelude) {
          return;
        }

        emittedResponsePrelude = true;
        // Grok rejects the upstream request if we emit SSE bytes before it starts streaming.
        writeSseEvent(res, "response.created", {
          type: "response.created",
          response: snapshot
        });
        writeSseEvent(res, "response.in_progress", {
          type: "response.in_progress",
          response: snapshot
        });
      };
      const emitMessagePrelude = () => {
        if (emittedMessagePrelude) {
          return;
        }

        emitResponsePrelude();
        emittedMessagePrelude = true;
        writeSseEvent(res, "response.output_item.added", {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: messageId,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: []
          }
        });
        writeSseEvent(res, "response.content_part.added", {
          type: "response.content_part.added",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: {
            type: "output_text",
            text: "",
            annotations: []
          }
        });
      };
      const emitTextDelta = (delta) => {
        if (!delta) {
          return;
        }

        emitMessagePrelude();
        emittedText.append(delta);
        writeSseEvent(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta
        });
      };
      const result = await runResponseRequest(parsed, normalized, {
        previousRecord,
        loadPreviousHistory: parsed.previous_response_id
          ? async () => {
              const record = await responseStore.getWithHistory(
                parsed.previous_response_id
              );
              return record?.history ?? null;
            }
          : null,
        onToken(token, meta) {
          if (meta?.isThinking) {
            return;
          }

          emitTextDelta(sanitizer.write(token));
        }
      });
      emitTextDelta(sanitizer.flush());
      const assistantOutput = await buildHostedAssistantOutput(
        result.state,
        streamingSourceAttribution,
        result.accountIndex
      );
      const images = assistantOutput.images;
      const renderedText = renderThoughtAndResponse({
        thoughtText: assistantOutput.thoughtText,
        responseText: assistantOutput.text
      });
      const emittedTextValue = emittedText.toString();
      const pendingText = getStreamingTextSuffix(renderedText, emittedTextValue);
      if (pendingText) {
        emitTextDelta(pendingText);
      }

      const text = renderedText || emittedText.toString();
      const hasMessage = Boolean(text);

      if (hasMessage) {
        emitMessagePrelude();
        writeSseEvent(res, "response.output_text.done", {
          type: "response.output_text.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text
        });
        writeSseEvent(res, "response.content_part.done", {
          type: "response.content_part.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: {
            type: "output_text",
            text,
            annotations: []
          }
        });
        writeSseEvent(res, "response.output_item.done", {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: messageId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text,
                annotations: []
              }
            ]
          }
        });
      }

      emitResponsePrelude();
      images.forEach((image, index) => {
        const outputIndex = hasMessage ? index + 1 : index;
        writeSseEvent(res, "response.output_item.added", {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: createResponseImageOutputItem({
            image,
            status: "in_progress"
          })
        });
        writeSseEvent(res, "response.output_item.done", {
          type: "response.output_item.done",
          output_index: outputIndex,
          item: createResponseImageOutputItem({
            image,
            status: "completed"
          })
        });
      });

      const finalResponse = createResponseEnvelope({
        id: responseId,
        messageId,
        model: publicModel,
        text,
        images,
        sourceAttribution: assistantOutput.sourceAttribution,
        instructions,
        previousResponseId: parsed.previous_response_id ?? null,
        metadata: parsed.metadata ?? {},
        store: parsed.store ?? true,
        request: parsed
      });

      const history = await buildConversationHistory({
        instructions,
        inputMessages: normalized.messages,
        assistantOutput: {
          text: assistantOutput.text,
          images
        },
        fileStore,
        loadAssistantImageAsset: (image) =>
          grokAccounts.fetchAsset(image.url, {
            accountIndex: result.accountIndex
          })
      });

      await responseStore.set({
        id: responseId,
        previous_response_id: parsed.previous_response_id ?? null,
        response: stripImageResultsFromResponse(finalResponse),
        grok: buildStoredGrokState({
          state: result.state,
          accountIndex: result.accountIndex,
          previousGrok: previousRecord?.grok ?? null
        }),
        history
      });

      emitResponsePrelude();
      writeSseEvent(res, "response.completed", {
        type: "response.completed",
        response: finalResponse
      });
      res.end();
      return;
    }

    const normalized = await normalizeConversationInput({
      requestBody: parsed,
      fileStore,
      loadRemoteImageAsset: (url) => grokAccounts.fetchAsset(url)
    });
    const result = await runResponseRequest(parsed, normalized, {
      previousRecord,
      loadPreviousHistory: parsed.previous_response_id
        ? async () => {
            const record = await responseStore.getWithHistory(
              parsed.previous_response_id
            );
            return record?.history ?? null;
          }
        : null
    });
    const assistantOutput = await buildHostedAssistantOutput(
      result.state,
      parsed.source_attribution,
      result.accountIndex
    );
    const images = assistantOutput.images;
    const text = assistantOutput.text;
    const history = await buildConversationHistory({
      instructions: normalized.instructions,
      inputMessages: normalized.messages,
      assistantOutput: {
        text: assistantOutput.text,
        images
      },
      fileStore,
      loadAssistantImageAsset: (image) =>
        grokAccounts.fetchAsset(image.url, {
          accountIndex: result.accountIndex
        })
    });
    const finalResponse = createResponseEnvelope({
      id: responseId,
      messageId,
      model: publicModel,
      text,
      images,
      sourceAttribution: assistantOutput.sourceAttribution,
      instructions: normalized.instructions,
      previousResponseId: parsed.previous_response_id ?? null,
      metadata: parsed.metadata ?? {},
      store: parsed.store ?? true,
      request: parsed
    });

    await responseStore.set({
      id: responseId,
      previous_response_id: parsed.previous_response_id ?? null,
      response: stripImageResultsFromResponse(finalResponse),
      grok: buildStoredGrokState({
        state: result.state,
        accountIndex: result.accountIndex,
        previousGrok: previousRecord?.grok ?? null
      }),
      history
    });

    res.status(200).json(finalResponse);
  } catch (error) {
    next(error);
  }
});

app.post("/v1/chat/completions", async (req, res, next) => {
  try {
    const prepared = await prepareChatCompletionRequest(req.body, {
      fileStore,
      defaultModel: config.defaultModel,
      loadRemoteImageAsset: (url) => grokAccounts.fetchAsset(url)
    });
    const { parsed, publicModel } = prepared;

    if (parsed.stream) {
      const chatCompletionId = createId("chatcmpl");
      const created = unixTimestampSeconds();
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");

      const streamingSourceAttribution = createStreamingSourceAttributionRequest(
        parsed.source_attribution
      );
      const sanitizer = createGrokMarkupStreamSanitizer();
      const emittedText = createTextAccumulator();
      let emittedAssistantRole = false;
      const ensureAssistantRoleEmitted = () => {
        if (emittedAssistantRole) {
          return;
        }

        emittedAssistantRole = true;
        // Grok rejects the upstream request if we emit SSE bytes before it starts streaming.
        res.write(
          `data: ${JSON.stringify(
            createChatCompletionChunk({
              id: chatCompletionId,
              model: publicModel,
              delta: { role: "assistant", content: "" },
              created
            })
          )}\n\n`
        );
      };
      const emitTextDelta = (delta) => {
        if (!delta) {
          return;
        }

        ensureAssistantRoleEmitted();
        emittedText.append(delta);
        res.write(
          `data: ${JSON.stringify(
            createChatCompletionChunk({
              id: chatCompletionId,
              model: publicModel,
              delta: { content: delta },
              created
            })
          )}\n\n`
        );
      };
      const result = await runChatCompletionRequest(prepared, {
        onToken(token, meta) {
          if (meta?.isThinking) {
            return;
          }

          emitTextDelta(sanitizer.write(token));
        }
      });
      emitTextDelta(sanitizer.flush());
      const assistantOutput = await buildHostedAssistantOutput(
        result.state,
        streamingSourceAttribution,
        result.accountIndex
      );
      const content = renderChatCompletionContent({
        text: renderThoughtAndResponse({
          thoughtText: assistantOutput.thoughtText,
          responseText: assistantOutput.text
        }),
        images: assistantOutput.images
      });
      const pendingText = getStreamingTextSuffix(content, emittedText.toString());
      if (pendingText) {
        emitTextDelta(pendingText);
      }

      ensureAssistantRoleEmitted();
      if (assistantOutput.images.length) {
        res.write(
          `data: ${JSON.stringify(
            createChatCompletionChunk({
              id: chatCompletionId,
              model: publicModel,
              delta: {
                image_urls: assistantOutput.images.map((image) => ({
                  url: image.url,
                  mime_type: image.mimeType ?? null,
                  title: image.title ?? null,
                  action: image.action ?? null,
                  prompt: image.prompt ?? null,
                  revised_prompt: image.revisedPrompt ?? null,
                  image_model: image.imageModel ?? null,
                  ...(image.thumbnailUrl ? { thumbnail_url: image.thumbnailUrl } : {}),
                  ...(image.sourcePageUrl ? { source_page_url: image.sourcePageUrl } : {}),
                  ...(image.sourceTitle ? { source_title: image.sourceTitle } : {}),
                  ...(image.sourceName ? { source_name: image.sourceName } : {})
                }))
              },
              created
            })
          )}\n\n`
        );
      }
      res.write(
        `data: ${JSON.stringify(
          createChatCompletionChunk({
            id: chatCompletionId,
            model: publicModel,
            delta: {},
            finishReason: "stop",
            created
          })
        )}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();

      return;
    }

    const result = await runChatCompletionRequest(prepared);
    const assistantOutput = await buildHostedAssistantOutput(
      result.state,
      parsed.source_attribution,
      result.accountIndex
    );
    const content = renderChatCompletionContent({
      text: assistantOutput.text,
      images: assistantOutput.images
    });
    const response = createChatCompletion({
      model: publicModel,
      content,
      imageUrls: assistantOutput.images,
      sourceAttribution: assistantOutput.sourceAttribution,
      created: unixTimestampSeconds()
    });

    res.status(200).json(response);
  } catch (error) {
    if (maybeHandleStreamingError(req, res, error)) {
      return;
    }
    next(error);
  }
});

app.use((error, req, res, _next) => {
  if (maybeHandleStreamingError(req, res, error)) {
    return;
  }

  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }

  if (error?.type === "entity.too.large") {
    const payload = toOpenAIError(
      new HttpError(413, buildJsonBodyTooLargeMessage(), {
        code: "request_too_large"
      })
    );
    res.status(payload.status).json(payload.body);
    return;
  }

  if (error?.code === "LIMIT_FILE_SIZE") {
    const payload = toOpenAIError(
      new HttpError(413, buildUploadedFileTooLargeMessage(), {
        code: "request_too_large"
      })
    );
    res.status(payload.status).json(payload.body);
    return;
  }

  const payload = toOpenAIError(error);
  res.status(payload.status).json(payload.body);
});

server = app.listen(config.port, config.host, () => {
  console.log(
    `grok-to-openai listening on http://${config.host}:${config.port}`
  );
});
