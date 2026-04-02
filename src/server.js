import express from "express";
import multer from "multer";
import path from "node:path";
import { config } from "./config.js";
import { ensureDir } from "./lib/fs.js";
import { HttpError, toOpenAIError } from "./lib/errors.js";
import { FileStore } from "./store/file-store.js";
import { ResponseStore } from "./store/response-store.js";
import { responsesCreateSchema } from "./openai/schema.js";
import { normalizeConversationInput } from "./openai/input.js";
import {
  createResponseEnvelope,
  createStreamingResponseSnapshot
} from "./openai/response-object.js";
import { initSse, writeSseEvent } from "./openai/sse.js";
import { createId } from "./lib/ids.js";
import { GrokClient } from "./grok/client.js";
import { listModels, resolveModel } from "./grok/model-map.js";

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
    uploaded.push(
      await grokClient.uploadFile({
        filename: file.filename,
        mimeType: file.mimeType,
        bytes: file.bytes
      })
    );
  }

  return uploaded;
}

async function executeManualHistory({
  messages,
  instructions,
  publicModel,
  onToken
}) {
  const conversation = await grokClient.createConversation();
  let previousAssistantId = null;
  let previousUserId = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const isLast = index === messages.length - 1;

    if (message.role === "assistant") {
      const assistantResponse = await grokClient.addModelResponse({
        conversationId: conversation.conversationId,
        parentResponseId: previousUserId,
        message: message.text
      });
      previousAssistantId = assistantResponse.responseId;
      continue;
    }

    if (!isLast) {
      if (message.files.length) {
        throw new HttpError(
          400,
          "Historical user file inputs are only supported when continuing with previous_response_id"
        );
      }

      const userResponse = await grokClient.addUserResponse({
        conversationId: conversation.conversationId,
        parentResponseId: previousAssistantId,
        message: message.text
      });
      previousUserId = userResponse.responseId;
      continue;
    }

    const fileAttachments = await uploadFilesToGrok(message.files);
    return grokClient.addResponse({
      conversationId: conversation.conversationId,
      parentResponseId: previousAssistantId,
      instructions,
      model: publicModel,
      message: message.text,
      fileAttachments,
      onToken
    });
  }

  throw new HttpError(400, "No final user message provided");
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

      let sawToken = false;
      const result = await runResponseRequest(parsed, {
        onToken(token) {
          sawToken = true;
          writeSseEvent(res, "response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta: token
          });
        }
      });
      const text = result.state.assistantText || result.state.modelResponse?.message || "";

      if (!sawToken && text) {
        for (const token of text) {
          writeSseEvent(res, "response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta: token
          });
        }
      }

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
    const text = result.state.assistantText || result.state.modelResponse?.message || "";
    const finalResponse = createResponseEnvelope({
      id: responseId,
      messageId,
      model: publicModel,
      text,
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

app.use((error, _req, res, _next) => {
  const payload = toOpenAIError(error);
  res.status(payload.status).json(payload.body);
});

app.listen(config.port, config.host, () => {
  console.log(
    `grok-to-openai listening on http://${config.host}:${config.port}`
  );
});
