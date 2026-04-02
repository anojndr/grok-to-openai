import express from "express";
import multer from "multer";
import { config } from "./config.js";
import { ensureDir } from "./lib/fs.js";
import { HttpError, toOpenAIError } from "./lib/errors.js";
import { FileStore } from "./store/file-store.js";
import { ResponseStore } from "./store/response-store.js";
import {
  chatCompletionsCreateSchema,
  responsesCreateSchema
} from "./openai/schema.js";
import {
  normalizeChatCompletionInput,
  normalizeConversationInput
} from "./openai/input.js";
import {
  createResponseEnvelope,
  createStreamingResponseSnapshot
} from "./openai/response-object.js";
import {
  createChatCompletion,
  createChatCompletionChunk
} from "./openai/chat-completions.js";
import { initSse, writeSseEvent } from "./openai/sse.js";
import { createId, unixTimestampSeconds } from "./lib/ids.js";
import { GrokClient } from "./grok/client.js";
import { createGrokMarkupStreamSanitizer } from "./grok/markup.js";
import { listModels, resolveModel } from "./grok/model-map.js";
import {
  createSourceAttributionPayload,
  extractSourceAttribution,
  renderGrokText,
  resolveSourceAttributionOptions
} from "./grok/source-attribution.js";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

await ensureDir(config.dataDir);

const fileStore = new FileStore(config.dataDir);
await fileStore.init();

const responseStore = new ResponseStore(config.dataDir);
await responseStore.init();

const grokClient = new GrokClient(config);

process.on("SIGINT", async () => {
  await grokClient.browser.close();
  process.exit(0);
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

app.use(express.json({ limit: "60mb" }));
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
    const record = await fileStore.create({
      filename: req.file.originalname,
      bytes: req.file.buffer,
      purpose,
      mimeType: req.file.mimetype
    });

    res.status(200).json(record);
  } catch (error) {
    if (maybeHandleStreamingError(req, res, error)) {
      return;
    }
    next(error);
  }
});

app.get("/v1/files/:fileId", async (req, res, next) => {
  try {
    const file = fileStore.get(req.params.fileId);
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
    const content = await fileStore.getContent(req.params.fileId);
    const record = fileStore.getRecord(req.params.fileId);
    if (!content || !record) {
      throw new HttpError(404, "File not found");
    }

    res.setHeader("Content-Type", record.mime_type || "application/octet-stream");
    res.send(content);
  } catch (error) {
    next(error);
  }
});

app.get("/v1/responses/:responseId", async (req, res, next) => {
  try {
    const record = responseStore.get(req.params.responseId);
    if (!record) {
      throw new HttpError(404, "Response not found");
    }

    res.json(record.response);
  } catch (error) {
    next(error);
  }
});

async function uploadFilesToGrok(files) {
  const uploaded = [];

  for (const file of files) {
    const upload = await grokClient.uploadFile({
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

function buildAssistantOutput(state, sourceAttributionRequest) {
  const rawText = state.assistantText || state.modelResponse?.message || "";
  const sourceAttributionOptions = resolveSourceAttributionOptions(
    sourceAttributionRequest
  );
  const sourceAttribution = extractSourceAttribution({
    assistantText: rawText,
    modelResponse: state.modelResponse
  });

  return {
    text: renderGrokText({
      text: rawText,
      sourceAttribution,
      options: sourceAttributionOptions
    }),
    sourceAttribution: createSourceAttributionPayload({
      sourceAttribution,
      options: sourceAttributionOptions
    }),
    options: sourceAttributionOptions
  };
}

function getStreamingTextSuffix(fullText, emittedText) {
  if (!emittedText) {
    return fullText;
  }

  if (fullText.startsWith(emittedText)) {
    return fullText.slice(emittedText.length);
  }

  let sharedPrefixLength = 0;
  while (
    sharedPrefixLength < fullText.length &&
    sharedPrefixLength < emittedText.length &&
    fullText[sharedPrefixLength] === emittedText[sharedPrefixLength]
  ) {
    sharedPrefixLength += 1;
  }

  return fullText.slice(sharedPrefixLength);
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
  const fileAttachments = await uploadFilesToGrok(lastMessage.files);
  const transcript = buildTranscriptPrompt(priorMessages);
  const combinedMessage = transcript
    ? `${transcript}\n\nUser: ${lastMessage.text}\n\nRespond to the latest user message.`
    : lastMessage.text;

  return grokClient.createConversationAndRespond({
    instructions,
    model: publicModel,
    message: combinedMessage,
    fileAttachments,
    onToken
  });
}

async function runResponseRequest(reqBody, options = {}) {
  const parsed = responsesCreateSchema.parse(reqBody);
  const normalized = await normalizeConversationInput({
    requestBody: parsed,
    fileStore
  });
  const onToken = options.onToken ?? null;

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
    const previous = responseStore.get(parsed.previous_response_id);
    if (!previous) {
      throw new HttpError(404, `Unknown previous_response_id: ${parsed.previous_response_id}`);
    }

    const lastUserMessage = normalized.messages[normalized.messages.length - 1];
    const fileAttachments = await uploadFilesToGrok(lastUserMessage.files);

    return grokClient.addResponse({
      conversationId: previous.grok.conversationId,
      parentResponseId: previous.grok.assistantResponseId,
      instructions: normalized.instructions,
      model: publicModel,
      message: lastUserMessage.text,
      fileAttachments,
      onToken
    });
  }

  if (normalized.messages.length === 1 && normalized.messages[0].role === "user") {
    const message = normalized.messages[0];
    const fileAttachments = await uploadFilesToGrok(message.files);

    return grokClient.createConversationAndRespond({
      instructions: normalized.instructions,
      model: publicModel,
      message: message.text,
      fileAttachments,
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
  const parsed = chatCompletionsCreateSchema.parse(reqBody);
  const normalized = await normalizeChatCompletionInput({
    requestBody: parsed,
    fileStore
  });
  const onToken = options.onToken ?? null;

  if (!normalized.messages.length) {
    throw new HttpError(400, "messages must include at least one user message");
  }

  if (parsed.n && parsed.n !== 1) {
    throw new HttpError(400, "Only n=1 is supported");
  }

  const { publicModel } = resolveModel(
    parsed.model,
    parsed.reasoning_effort === "none" || parsed.reasoning_effort === "minimal"
      ? undefined
      : parsed.reasoning_effort,
    config.defaultModel
  );

  if (normalized.messages.length === 1 && normalized.messages[0].role === "user") {
    const message = normalized.messages[0];
    const fileAttachments = await uploadFilesToGrok(message.files);

    return grokClient.createConversationAndRespond({
      instructions: normalized.instructions,
      model: publicModel,
      message: message.text,
      fileAttachments,
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

app.post("/v1/responses", async (req, res, next) => {
  try {
    const requestBody = req.body;
    const responseId = createId("resp");
    const messageId = createId("msg");
    const parsed = responsesCreateSchema.parse(requestBody);
    const { publicModel } = resolveModel(
      parsed.model,
      parsed.reasoning?.effort,
      config.defaultModel
    );

    if (parsed.stream) {
      initSse(res);

      const normalized = await normalizeConversationInput({
        requestBody: parsed,
        fileStore
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

      const sourceAttributionOptions = resolveSourceAttributionOptions(
        parsed.source_attribution
      );
      const sanitizer = createGrokMarkupStreamSanitizer({
        stopAtRenderTag: sourceAttributionOptions.inlineCitations
      });
      let sawToken = false;
      let emittedText = "";
      let emittedPrelude = false;
      const emitPrelude = () => {
        if (emittedPrelude) {
          return;
        }

        emittedPrelude = true;
        // Grok rejects the upstream request if we emit SSE bytes before it starts streaming.
        writeSseEvent(res, "response.created", {
          type: "response.created",
          response: snapshot
        });
        writeSseEvent(res, "response.in_progress", {
          type: "response.in_progress",
          response: snapshot
        });
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
      const result = await runResponseRequest(parsed, {
        onToken(token) {
          const visible = sanitizer.write(token);
          if (!visible) {
            return;
          }

          emitPrelude();
          sawToken = true;
          emittedText += visible;
          writeSseEvent(res, "response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta: visible
          });
        }
      });
      const flushed = sanitizer.flush();
      if (flushed) {
        emitPrelude();
        sawToken = true;
        emittedText += flushed;
        writeSseEvent(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta: flushed
        });
      }
      const assistantOutput = buildAssistantOutput(
        result.state,
        parsed.source_attribution
      );
      const text = assistantOutput.text;
      const pendingText = getStreamingTextSuffix(text, emittedText);

      if (pendingText) {
        emitPrelude();
        sawToken = true;
        writeSseEvent(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta: pendingText
        });
      }

      emitPrelude();
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

      const finalResponse = createResponseEnvelope({
        id: responseId,
        messageId,
        model: publicModel,
        text,
        sourceAttribution: assistantOutput.sourceAttribution,
        instructions,
        previousResponseId: parsed.previous_response_id ?? null,
        metadata: parsed.metadata ?? {},
        store: parsed.store ?? true,
        request: parsed
      });

      await responseStore.set({
        id: responseId,
        response: finalResponse,
        grok: {
          conversationId: result.state.conversation?.conversationId,
          assistantResponseId: result.state.modelResponse?.responseId,
          userResponseId: result.state.userResponse?.responseId
        }
      });

      writeSseEvent(res, "response.completed", {
        type: "response.completed",
        response: finalResponse
      });
      res.end();
      return;
    }

    const normalized = await normalizeConversationInput({
      requestBody: parsed,
      fileStore
    });
    const result = await runResponseRequest(parsed);
    const assistantOutput = buildAssistantOutput(
      result.state,
      parsed.source_attribution
    );
    const text = assistantOutput.text;
    const finalResponse = createResponseEnvelope({
      id: responseId,
      messageId,
      model: publicModel,
      text,
      sourceAttribution: assistantOutput.sourceAttribution,
      instructions: normalized.instructions,
      previousResponseId: parsed.previous_response_id ?? null,
      metadata: parsed.metadata ?? {},
      store: parsed.store ?? true,
      request: parsed
    });

    await responseStore.set({
      id: responseId,
      response: finalResponse,
      grok: {
        conversationId: result.state.conversation?.conversationId,
        assistantResponseId: result.state.modelResponse?.responseId,
        userResponseId: result.state.userResponse?.responseId
      }
    });

    res.status(200).json(finalResponse);
  } catch (error) {
    next(error);
  }
});

app.post("/v1/chat/completions", async (req, res, next) => {
  try {
    const parsed = chatCompletionsCreateSchema.parse(req.body);
    const { publicModel } = resolveModel(
      parsed.model,
      parsed.reasoning_effort === "none" || parsed.reasoning_effort === "minimal"
        ? undefined
        : parsed.reasoning_effort,
      config.defaultModel
    );

    if (parsed.stream) {
      const chatCompletionId = createId("chatcmpl");
      const created = unixTimestampSeconds();
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");

      const sourceAttributionOptions = resolveSourceAttributionOptions(
        parsed.source_attribution
      );
      const sanitizer = createGrokMarkupStreamSanitizer({
        stopAtRenderTag: sourceAttributionOptions.inlineCitations
      });
      let sawToken = false;
      let emittedText = "";
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
      const result = await runChatCompletionRequest(parsed, {
        onToken(token) {
          const visible = sanitizer.write(token);
          if (!visible) {
            return;
          }

          ensureAssistantRoleEmitted();
          sawToken = true;
          emittedText += visible;
          res.write(
            `data: ${JSON.stringify(
              createChatCompletionChunk({
                id: chatCompletionId,
                model: publicModel,
                delta: { content: visible },
                created
              })
            )}\n\n`
          );
        }
      });
      const flushed = sanitizer.flush();
      if (flushed) {
        ensureAssistantRoleEmitted();
        sawToken = true;
        emittedText += flushed;
        res.write(
          `data: ${JSON.stringify(
            createChatCompletionChunk({
              id: chatCompletionId,
              model: publicModel,
              delta: { content: flushed },
              created
            })
            )}\n\n`
        );
      }
      const assistantOutput = buildAssistantOutput(
        result.state,
        parsed.source_attribution
      );
      const text = assistantOutput.text;
      const pendingText = getStreamingTextSuffix(text, emittedText);
      if (pendingText) {
        ensureAssistantRoleEmitted();
        sawToken = true;
        res.write(
          `data: ${JSON.stringify(
            createChatCompletionChunk({
              id: chatCompletionId,
              model: publicModel,
              delta: { content: pendingText },
              created
            })
          )}\n\n`
        );
      }

      ensureAssistantRoleEmitted();
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

    const result = await runChatCompletionRequest(parsed);
    const assistantOutput = buildAssistantOutput(
      result.state,
      parsed.source_attribution
    );
    const text = assistantOutput.text;
    const response = createChatCompletion({
      model: publicModel,
      content: text,
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

  const payload = toOpenAIError(error);
  res.status(payload.status).json(payload.body);
});

app.listen(config.port, config.host, () => {
  console.log(
    `grok-to-openai listening on http://${config.host}:${config.port}`
  );
});
