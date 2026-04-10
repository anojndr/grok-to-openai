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
    const record = await fileStore.getRecord(file.fileId);
    if (record) {
      return {
        fileId: file.fileId,
        filename: record.filename,
        mimeType: record.mime_type || file.mimeType || "application/octet-stream"
      };
    }
  }

  const record = await fileStore.create({
    filename: file.filename || "attachment.bin",
    bytes: file.bytes,
    purpose: "conversation_history",
    mimeType: file.mimeType || "application/octet-stream"
  });
  const stored = await fileStore.getRecord(record.id);

  return {
    fileId: record.id,
    filename: stored?.filename || record.filename,
    mimeType: stored?.mime_type || file.mimeType || "application/octet-stream"
  };
}

async function persistConversationMessages(messages, fileStore) {
  const storedMessages = [];

  for (const message of messages) {
    const attachments = [];

    for (const file of message.files ?? []) {
      attachments.push(await persistAttachment(file, fileStore));
    }

    storedMessages.push({
      role: message.role,
      text: message.text || "",
      attachments
    });
  }

  return storedMessages;
}

async function persistAssistantMessage(assistantOutput, fileStore) {
  const text = assistantOutput?.text || "";
  const images = assistantOutput?.images ?? [];
  const attachments = [];

  for (const [index, image] of images.entries()) {
    if (!image.result) {
      continue;
    }

    const bytes = Buffer.from(image.result, "base64");
    const record = await fileStore.create({
      filename: inferAssistantAttachmentFilename(image, index),
      bytes,
      purpose: "conversation_history",
      mimeType: image.mimeType || "application/octet-stream"
    });
    const stored = await fileStore.getRecord(record.id);

    attachments.push({
      fileId: record.id,
      filename: stored?.filename || record.filename,
      mimeType: stored?.mime_type || image.mimeType || "application/octet-stream"
    });
  }

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
  previousHistory = null,
  instructions = "",
  inputMessages = [],
  assistantOutput = null,
  fileStore
}) {
  const storedMessages = await persistConversationMessages(inputMessages, fileStore);
  const assistantMessage = await persistAssistantMessage(assistantOutput, fileStore);

  return {
    instructions: toInstructionList(previousHistory?.instructions ?? [], instructions),
    messages: [
      ...(previousHistory?.messages ?? []),
      ...storedMessages,
      ...(assistantMessage ? [assistantMessage] : [])
    ]
  };
}

async function hydrateStoredMessage(storedMessage, fileStore) {
  const files = [];

  for (const attachment of storedMessage.attachments ?? []) {
    const bytes = await fileStore.getContent(attachment.fileId);
    if (!bytes) {
      throw new HttpError(
        500,
        `Stored conversation attachment is missing: ${attachment.fileId}`
      );
    }

    files.push({
      filename: attachment.filename,
      mimeType: attachment.mimeType || "application/octet-stream",
      bytes
    });
  }

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
  onToken = null
}) {
  const lastUserMessage = currentMessages[currentMessages.length - 1];
  if (!lastUserMessage || lastUserMessage.role !== "user") {
    throw new HttpError(400, "The final message must be a user message");
  }

  const accounts = grokAccounts ?? createSingleAccountAdapter(grokClient);
  const preferredAccountIndex = previousRecord.grok?.accountIndex ?? 0;

  try {
    const result = await accounts.withAccount(
      preferredAccountIndex,
      async (accountClient) => {
        const fileAttachments = await uploadFilesForAccount(
          uploadFilesToGrok,
          accountClient,
          lastUserMessage.files
        );

        return accountClient.addResponse({
          conversationId: previousRecord.grok.conversationId,
          parentResponseId: previousRecord.grok.assistantResponseId,
          instructions,
          model: publicModel,
          message: lastUserMessage.text,
          fileAttachments,
          onToken
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
  }

  const replay = await buildReplayConversationRequest({
    previousHistory: previousRecord.history,
    currentMessages,
    fileStore
  });

  const replayResult = await withFastModelFallback({
    publicModel,
    async operation(model) {
      return accounts.withFallback(async (accountClient) => {
        const replayFileAttachments = await uploadFilesForAccount(
          uploadFilesToGrok,
          accountClient,
          replay.files
        );

        return accountClient.createConversationAndRespond({
          instructions,
          model,
          message: replay.message,
          fileAttachments: replayFileAttachments,
          onToken
        });
      });
    }
  });

  return {
    accountIndex: replayResult.accountIndex,
    ...replayResult.value
  };
}
