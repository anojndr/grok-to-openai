import path from "node:path";
import { sanitizeFilename } from "../lib/fs.js";
import { HttpError } from "../lib/errors.js";
import { withFastModelFallback } from "../grok/model-fallback.js";

function toInstructionList(previousInstructions = [], instructions = "") {
  const merged = [];

  for (const instruction of previousInstructions) {
    if (instruction && !merged.includes(instruction)) {
      merged.push(instruction);
    }
  }

  const trimmed = instructions.trim();
  if (trimmed && !merged.includes(trimmed)) {
    merged.push(trimmed);
  }

  return merged;
}

function inferExtensionFromMimeType(mimeType) {
  switch ((mimeType || "").toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "text/plain":
      return ".txt";
    case "application/pdf":
      return ".pdf";
    default:
      return "";
  }
}

function inferFilenameFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    const base = path.basename(url.pathname);
    return sanitizeFilename(base || "attachment");
  } catch {
    return "attachment";
  }
}

function inferAssistantAttachmentFilename(image, index) {
  if (image.url) {
    const filename = inferFilenameFromUrl(image.url);
    if (filename && filename !== "attachment") {
      return filename;
    }
  }

  if (image.title) {
    const extension = inferExtensionFromMimeType(image.mimeType) || ".bin";
    return `${sanitizeFilename(image.title)}${extension}`;
  }

  return `assistant-image-${index + 1}${inferExtensionFromMimeType(image.mimeType) || ".bin"}`;
}

async function persistAttachment(file, fileStore) {
  if (file.fileId) {
    const record =
      typeof fileStore.getRecord === "function"
        ? await fileStore.getRecord(file.fileId)
        : (await fileStore.getWithContent?.(file.fileId))?.record ?? null;
    if (record) {
      return {
        fileId: file.fileId,
        filename: record.filename,
        mimeType: record.mime_type || file.mimeType || "application/octet-stream"
      };
    }
  }

  const mimeType = file.mimeType || "application/octet-stream";
  const record = await fileStore.create({
    filename: file.filename || "attachment.bin",
    bytes: file.bytes,
    purpose: "conversation_history",
    mimeType
  });

  return {
    fileId: record.id,
    filename: record.filename,
    mimeType
  };
}

async function persistConversationMessages(messages, fileStore) {
  return Promise.all(messages.map(async (message) => {
    const attachments = await Promise.all(
      (message.files ?? []).map((file) => persistAttachment(file, fileStore))
    );

    return {
      role: message.role,
      text: message.text || "",
      attachments
    };
  }));
}

async function resolveAssistantImageAsset(image, loadAssistantImageAsset) {
  if (image?.bytes) {
    return {
      bytes: Buffer.isBuffer(image.bytes) ? image.bytes : Buffer.from(image.bytes),
      mimeType: image.mimeType || "application/octet-stream"
    };
  }

  if (image?.result) {
    return {
      bytes: Buffer.from(image.result, "base64"),
      mimeType: image.mimeType || "application/octet-stream"
    };
  }

  if (!image?.url || typeof loadAssistantImageAsset !== "function") {
    return null;
  }

  let asset;
  try {
    asset = await loadAssistantImageAsset(image);
  } catch {
    return null;
  }

  if (!asset?.bytes) {
    return null;
  }

  return {
    bytes: Buffer.isBuffer(asset.bytes) ? asset.bytes : Buffer.from(asset.bytes),
    mimeType:
      image.mimeType ||
      asset.mimeType ||
      asset.contentType ||
      "application/octet-stream"
  };
}

async function persistAssistantMessage(
  assistantOutput,
  fileStore,
  loadAssistantImageAsset
) {
  const text = assistantOutput?.text || "";
  const images = assistantOutput?.images ?? [];
  const attachments = (await Promise.all(images.map(async (image, index) => {
    const asset = await resolveAssistantImageAsset(
      image,
      loadAssistantImageAsset
    );
    if (!asset) {
      return null;
    }

    const record = await fileStore.create({
      filename: inferAssistantAttachmentFilename(image, index),
      bytes: asset.bytes,
      purpose: "conversation_history",
      mimeType: asset.mimeType
    });

    return {
      fileId: record.id,
      filename: record.filename,
      mimeType: asset.mimeType
    };
  }))).filter(Boolean);

  if (!text && attachments.length === 0) {
    return null;
  }

  return {
    role: "assistant",
    text,
    attachments
  };
}

export async function buildConversationHistory({
  previousHistory: _previousHistory = null,
  instructions = "",
  inputMessages = [],
  assistantOutput = null,
  fileStore,
  loadAssistantImageAsset = null
}) {
  const [storedMessages, assistantMessage] = await Promise.all([
    persistConversationMessages(inputMessages, fileStore),
    persistAssistantMessage(
      assistantOutput,
      fileStore,
      loadAssistantImageAsset
    )
  ]);

  return {
    version: 2,
    instructions: toInstructionList([], instructions),
    messages: [
      ...storedMessages,
      ...(assistantMessage ? [assistantMessage] : [])
    ]
  };
}

async function hydrateStoredMessage(storedMessage, fileStore) {
  const files = await Promise.all((storedMessage.attachments ?? []).map(async (attachment) => {
    const bytes = await fileStore.getContent(attachment.fileId);
    if (!bytes) {
      throw new HttpError(
        500,
        `Stored conversation attachment is missing: ${attachment.fileId}`
      );
    }

    return {
      filename: attachment.filename,
      mimeType: attachment.mimeType || "application/octet-stream",
      bytes
    };
  }));

  return {
    role: storedMessage.role,
    text: storedMessage.text || "",
    files
  };
}

async function hydrateHistoryMessages(messages, fileStore) {
  return Promise.all(messages.map((message) => hydrateStoredMessage(message, fileStore)));
}

function roleLabel(role) {
  if (role === "assistant") {
    return "Assistant";
  }

  if (role === "user") {
    return "User";
  }

  if (role === "system") {
    return "System";
  }

  if (role === "developer") {
    return "Developer";
  }

  return role;
}

function buildReplayAttachmentFilename({
  turnNumber,
  role,
  attachmentNumber,
  originalFilename
}) {
  const safeOriginal = sanitizeFilename(originalFilename || "attachment.bin");

  return `turn-${String(turnNumber).padStart(3, "0")}-${role}-attachment-${String(
    attachmentNumber
  ).padStart(3, "0")}-${safeOriginal}`;
}

function buildAttachmentSummary({ uploadedFilename, originalFilename, mimeType }) {
  if (uploadedFilename === originalFilename) {
    return `- ${uploadedFilename} (${mimeType || "application/octet-stream"})`;
  }

  return `- ${uploadedFilename} (original name: ${originalFilename}; type: ${
    mimeType || "application/octet-stream"
  })`;
}

export async function buildReplayConversationRequest({
  previousHistory = null,
  currentMessages,
  fileStore
}) {
  const historyMessages = previousHistory?.messages?.length
    ? await hydrateHistoryMessages(previousHistory.messages, fileStore)
    : [];
  const replayMessages = [...historyMessages, ...currentMessages];
  const replayFiles = [];
  const lines = [
    "The original Grok conversation could not be found in the active account.",
    "Continue the conversation from the reconstructed history below and answer only the final user message."
  ];

  if (previousHistory?.instructions?.length) {
    lines.push("", "Prior instructions:");
    for (const instruction of previousHistory.instructions) {
      lines.push(`- ${instruction}`);
    }
  }

  lines.push("", "Conversation history:");

  replayMessages.forEach((message, messageIndex) => {
    const turnNumber = messageIndex + 1;
    lines.push("", `Turn ${turnNumber} | ${roleLabel(message.role)}`);
    lines.push(message.text || "[No text]");

    if (!(message.files ?? []).length) {
      return;
    }

    lines.push("Attachments:");

    message.files.forEach((file, attachmentIndex) => {
      const uploadedFilename = buildReplayAttachmentFilename({
        turnNumber,
        role: message.role,
        attachmentNumber: attachmentIndex + 1,
        originalFilename: file.filename
      });

      replayFiles.push({
        filename: uploadedFilename,
        mimeType: file.mimeType || "application/octet-stream",
        bytes: file.bytes
      });
      lines.push(
        buildAttachmentSummary({
          uploadedFilename,
          originalFilename: file.filename,
          mimeType: file.mimeType
        })
      );
    });
  });

  lines.push(
    "",
    "Respond to the final user message using the full conversation history and every attachment listed above."
  );

  return {
    message: lines.join("\n"),
    files: replayFiles
  };
}

function collectErrorMessages(error) {
  if (!(error instanceof Error)) {
    return [];
  }

  const messages = [];
  const pushMessage = (value) => {
    if (typeof value === "string" && value) {
      messages.push(value.toLowerCase());
    }
  };

  pushMessage(error.message);

  if (error instanceof HttpError) {
    pushMessage(error.details?.message);
    pushMessage(error.details?.error?.message);
  }

  return messages;
}

export function isMissingConversationError(error) {
  return collectErrorMessages(error).some(
    (message) =>
      ((message.includes("conversation") &&
        (message.includes("not found") ||
          message.includes("missing") ||
          message.includes("unknown") ||
          message.includes("does not exist") ||
          message.includes("not in this account") ||
          message.includes("not present"))) ||
        (message.includes("parentresponse") && message.includes("not found")))
  );
}

function createSingleAccountAdapter(grokClient) {
  return {
    async withAccount(accountIndex, operation) {
      return {
        accountIndex: Number.isInteger(accountIndex) ? accountIndex : 0,
        value: await operation(grokClient, accountIndex)
      };
    },
    async withFallback(operation) {
      return {
        accountIndex: 0,
        value: await operation(grokClient, 0)
      };
    }
  };
}

async function uploadFilesForAccount(uploadFilesToGrok, accountClient, files) {
  if (uploadFilesToGrok.length >= 2) {
    return uploadFilesToGrok(accountClient, files);
  }

  return uploadFilesToGrok(files);
}

export async function continueResponseConversation({
  previousRecord,
  currentMessages,
  instructions,
  publicModel,
  grokAccounts = null,
  grokClient,
  uploadFilesToGrok,
  fileStore,
  onToken = null,
  loadPreviousHistory = null
}) {
  const lastUserMessage = currentMessages[currentMessages.length - 1];
  if (!lastUserMessage || lastUserMessage.role !== "user") {
    throw new HttpError(400, "The final message must be a user message");
  }

  const accounts = grokAccounts ?? createSingleAccountAdapter(grokClient);
  const preferredAccountIndex = previousRecord.grok?.accountIndex ?? 0;
  let followUpError = null;

  try {
    const result = await accounts.withAccount(
      preferredAccountIndex,
      async (accountClient) => {
        const fileAttachments = await uploadFilesForAccount(
          uploadFilesToGrok,
          accountClient,
          lastUserMessage.files
        );

        return withFastModelFallback({
          publicModel,
          async operation(model) {
            return accountClient.addResponse({
              conversationId: previousRecord.grok.conversationId,
              parentResponseId: previousRecord.grok.assistantResponseId,
              instructions,
              model,
              message: lastUserMessage.text,
              fileAttachments,
              onToken
            });
          }
        });
      }
    );

    return {
      accountIndex: result.accountIndex,
      ...result.value
    };
  } catch (error) {
    if (!previousRecord.history?.messages?.length) {
      throw error;
    }

    followUpError = error;
  }

  const previousHistory = loadPreviousHistory
    ? await loadPreviousHistory()
    : previousRecord.history;

  if (!previousHistory?.messages?.length) {
    throw followUpError;
  }

  const replay = await buildReplayConversationRequest({
    previousHistory,
    currentMessages,
    fileStore
  });

  const replayResult = await accounts.withFallback(async (accountClient) => {
    const replayFileAttachments = await uploadFilesForAccount(
      uploadFilesToGrok,
      accountClient,
      replay.files
    );

    return withFastModelFallback({
      publicModel,
      async operation(model) {
        return accountClient.createConversationAndRespond({
          instructions,
          model,
          message: replay.message,
          fileAttachments: replayFileAttachments,
          onToken
        });
      }
    });
  });

  return {
    accountIndex: replayResult.accountIndex,
    ...replayResult.value
  };
}
