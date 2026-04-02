import path from "node:path";
import { HttpError } from "../lib/errors.js";

function ensureArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  return [value];
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((part) => ["input_text", "text", "output_text"].includes(part.type))
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function extractFileParts(content) {
  if (typeof content === "string") {
    return [];
  }

  return content.filter((part) => part.type === "input_file");
}

export function normalizeMessages(input) {
  if (input == null) {
    return [];
  }

  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  return ensureArray(input);
}

export function splitInstructionsAndMessages(messages, explicitInstructions = "") {
  const instructions = [];
  const conversationMessages = [];

  if (explicitInstructions) {
    instructions.push(explicitInstructions.trim());
  }

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = extractTextContent(message.content);
      if (text) {
        instructions.push(text);
      }
      continue;
    }

    conversationMessages.push(message);
  }

  return {
    instructions: instructions.filter(Boolean).join("\n\n"),
    messages: conversationMessages
  };
}

function inferFilenameFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    const base = path.basename(url.pathname);
    return base || "remote-file";
  } catch {
    return "remote-file";
  }
}

export async function resolveFileParts({
  content,
  fileStore
}) {
  const fileParts = extractFileParts(content);
  const resolved = [];

  for (const filePart of fileParts) {
    if (filePart.file_id) {
      const record = fileStore.getRecord(filePart.file_id);
      if (!record) {
        throw new HttpError(400, `Unknown file_id: ${filePart.file_id}`);
      }

      const bytes = await fileStore.getContent(filePart.file_id);
      resolved.push({
        filename: record.filename,
        mimeType: record.mime_type,
        bytes,
        source: "file_id"
      });
      continue;
    }

    if (filePart.file_url) {
      const response = await fetch(filePart.file_url);
      if (!response.ok) {
        throw new HttpError(
          400,
          `Unable to fetch file_url: ${filePart.file_url}`
        );
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      resolved.push({
        filename: filePart.filename || inferFilenameFromUrl(filePart.file_url),
        mimeType: response.headers.get("content-type") || "application/octet-stream",
        bytes: buffer,
        source: "file_url"
      });
      continue;
    }

    if (filePart.file_data) {
      const data = filePart.file_data;
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(data);
      const mimeType = match?.[1] || "application/octet-stream";
      const base64 = match?.[2] || data;
      resolved.push({
        filename: filePart.filename || "upload.bin",
        mimeType,
        bytes: Buffer.from(base64, "base64"),
        source: "file_data"
      });
      continue;
    }

    throw new HttpError(400, "input_file requires file_id, file_url, or file_data");
  }

  return resolved;
}

export async function normalizeConversationInput({
  requestBody,
  fileStore
}) {
  const rawMessages = normalizeMessages(requestBody.input);
  const { instructions, messages } = splitInstructionsAndMessages(
    rawMessages,
    requestBody.instructions
  );

  const normalizedMessages = [];

  for (const message of messages) {
    const text = extractTextContent(message.content);
    const files = await resolveFileParts({
      content: message.content,
      fileStore
    });

    normalizedMessages.push({
      role: message.role,
      text,
      files
    });
  }

  return {
    instructions,
    messages: normalizedMessages
  };
}
