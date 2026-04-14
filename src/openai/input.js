import path from "node:path";
import { HttpError } from "../lib/errors.js";
import {
  buildLargeFileInputMessage,
  buildLargeImageInputMessage,
  MAX_DIRECT_FILE_BYTES,
  MAX_DIRECT_IMAGE_BYTES
} from "../lib/request-limits.js";

const REMOTE_IMAGE_FETCH_HEADERS = Object.freeze({
  Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
});

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

function inferMimeTypeFromFilename(filename = "") {
  switch (path.extname(filename).toLowerCase()) {
    case ".csv":
      return "text/csv";
    case ".txt":
      return "text/plain";
    case ".tsv":
      return "text/tab-separated-values";
    default:
      return "";
  }
}

function inferExtensionFromMimeType(mimeType) {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return "";
  }
}

function isTextLikeMimeType(mimeType = "") {
  return mimeType.startsWith("text/");
}

function looksLikeBase64(value) {
  const normalized = value.replace(/\s+/g, "");

  if (!normalized || normalized.length % 4 !== 0) {
    return false;
  }

  return /^[A-Za-z0-9+/]+={0,2}$/.test(normalized);
}

function isMostlyPrintableText(text) {
  if (!text) {
    return true;
  }

  let printableCount = 0;

  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      printableCount += 1;
    }
  }

  return printableCount / text.length >= 0.85;
}

function bufferLooksLikeUtf8Text(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return isMostlyPrintableText(text);
  } catch {
    return false;
  }
}

function formatInputTooLargeError(actualBytes, maxBytes, message) {
  if (actualBytes > maxBytes) {
    throw new HttpError(400, message);
  }
}

function estimateBase64DecodedBytes(value) {
  const normalized = value.replace(/\s+/g, "");

  if (!normalized) {
    return 0;
  }

  let padding = 0;
  if (normalized.endsWith("==")) {
    padding = 2;
  } else if (normalized.endsWith("=")) {
    padding = 1;
  }

  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function normalizeMimeType(mimeType = "") {
  return mimeType.split(";")[0].trim().toLowerCase();
}

function inferImageMimeTypeFromBytes(bytes) {
  if (!bytes?.length) {
    return "";
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  const gifSignature = bytes.subarray(0, 6).toString("ascii");
  if (gifSignature === "GIF87a" || gifSignature === "GIF89a") {
    return "image/gif";
  }

  const leadingText = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (leadingText.startsWith("<svg") || (leadingText.startsWith("<?xml") && leadingText.includes("<svg"))) {
    return "image/svg+xml";
  }

  return "";
}

function resolveRemoteImageMimeType({ responseMimeType, bytes }) {
  const normalizedResponseMimeType = normalizeMimeType(responseMimeType);
  const sniffedMimeType = inferImageMimeTypeFromBytes(bytes);

  if (normalizedResponseMimeType.startsWith("image/")) {
    return normalizedResponseMimeType;
  }

  if (
    normalizedResponseMimeType === "" ||
    normalizedResponseMimeType === "application/octet-stream" ||
    normalizedResponseMimeType === "binary/octet-stream"
  ) {
    return sniffedMimeType;
  }

  return sniffedMimeType;
}

function buildInvalidRemoteImageMessage(imageUrl, mimeType = "") {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const mimeTypeSuffix = normalizedMimeType
    ? ` (received ${normalizedMimeType})`
    : "";
  return (
    `image_url did not return image data: ${imageUrl}${mimeTypeSuffix}. ` +
    "Remote hosts may block server-side fetches with Cloudflare or other bot challenges."
  );
}

async function readResponseBytes(response, { maxBytes, tooLargeMessage }) {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new HttpError(400, tooLargeMessage);
    }
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    if (!value?.byteLength) {
      continue;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      try {
        await reader.cancel();
      } catch {}
      throw new HttpError(400, tooLargeMessage);
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, totalBytes);
}

function decodeInlineFileData({ data, filename }) {
  const tooLargeMessage = buildLargeFileInputMessage();
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(data);
  if (match) {
    const normalized = match[2].replace(/\s+/g, "");
    formatInputTooLargeError(
      estimateBase64DecodedBytes(normalized),
      MAX_DIRECT_FILE_BYTES,
      tooLargeMessage
    );
    return {
      mimeType: match[1] || inferMimeTypeFromFilename(filename) || "application/octet-stream",
      bytes: Buffer.from(normalized, "base64")
    };
  }

  const inferredMimeType = inferMimeTypeFromFilename(filename);
  if (!looksLikeBase64(data)) {
    formatInputTooLargeError(
      Buffer.byteLength(data, "utf8"),
      MAX_DIRECT_FILE_BYTES,
      tooLargeMessage
    );
    return {
      mimeType: inferredMimeType || "application/octet-stream",
      bytes: Buffer.from(data, "utf8")
    };
  }

  const normalized = data.replace(/\s+/g, "");
  formatInputTooLargeError(
    estimateBase64DecodedBytes(normalized),
    MAX_DIRECT_FILE_BYTES,
    tooLargeMessage
  );
  const decodedBytes = Buffer.from(normalized, "base64");
  const shouldKeepRawText =
    isTextLikeMimeType(inferredMimeType) &&
    isMostlyPrintableText(data) &&
    !bufferLooksLikeUtf8Text(decodedBytes);

  if (shouldKeepRawText) {
    formatInputTooLargeError(
      Buffer.byteLength(data, "utf8"),
      MAX_DIRECT_FILE_BYTES,
      tooLargeMessage
    );
    return {
      mimeType: inferredMimeType,
      bytes: Buffer.from(data, "utf8")
    };
  }

  return {
    mimeType: inferredMimeType || "application/octet-stream",
    bytes: decodedBytes
  };
}

function extractImageParts(content) {
  if (typeof content === "string") {
    return [];
  }

  return content.filter((part) => part.type === "input_image" || part.type === "image_url");
}

function getImageUrlValue(part) {
  if (part.type === "input_image") {
    return part.image_url;
  }

  if (typeof part.image_url === "string") {
    return part.image_url;
  }

  return part.image_url?.url;
}

export async function resolveFileParts({
  content,
  fileStore
}) {
  const fileParts = extractFileParts(content);
  return Promise.all(fileParts.map(async (filePart) => {
    if (filePart.file_id) {
      const stored = await fileStore.getWithContent(filePart.file_id);
      if (!stored?.record) {
        throw new HttpError(400, `Unknown file_id: ${filePart.file_id}`);
      }

      return {
        fileId: filePart.file_id,
        filename: stored.record.filename,
        mimeType: stored.record.mime_type,
        bytes: stored.content,
        source: "file_id"
      };
    }

    if (filePart.file_url) {
      const response = await fetch(filePart.file_url);
      if (!response.ok) {
        throw new HttpError(
          400,
          `Unable to fetch file_url: ${filePart.file_url}`
        );
      }

      const buffer = await readResponseBytes(response, {
        maxBytes: MAX_DIRECT_FILE_BYTES,
        tooLargeMessage: buildLargeFileInputMessage()
      });
      return {
        filename: filePart.filename || inferFilenameFromUrl(filePart.file_url),
        mimeType: response.headers.get("content-type") || "application/octet-stream",
        bytes: buffer,
        source: "file_url"
      };
    }

    if (filePart.file_data) {
      const decoded = decodeInlineFileData({
        data: filePart.file_data,
        filename: filePart.filename || "upload.bin"
      });
      return {
        filename: filePart.filename || "upload.bin",
        mimeType: decoded.mimeType,
        bytes: decoded.bytes,
        source: "file_data"
      };
    }

    throw new HttpError(400, "input_file requires file_id, file_url, or file_data");
  }));
}

export async function resolveImageParts({ content }) {
  const imageParts = extractImageParts(content);
  return Promise.all(imageParts.map(async (imagePart) => {
    const imageUrl = getImageUrlValue(imagePart);
    if (!imageUrl) {
      throw new HttpError(400, "image input requires image_url");
    }

    const match = /^data:([^;,]+);base64,(.+)$/s.exec(imageUrl);
    if (match) {
      const mimeType = match[1] || "application/octet-stream";
      const normalized = match[2].replace(/\s+/g, "");
      formatInputTooLargeError(
        estimateBase64DecodedBytes(normalized),
        MAX_DIRECT_IMAGE_BYTES,
        buildLargeImageInputMessage()
      );
      return {
        filename: `image${inferExtensionFromMimeType(mimeType) || ".bin"}`,
        mimeType,
        bytes: Buffer.from(normalized, "base64"),
        source: "image_data_url"
      };
    }

    const response = await fetch(imageUrl, {
      headers: REMOTE_IMAGE_FETCH_HEADERS
    });
    if (!response.ok) {
      throw new HttpError(400, `Unable to fetch image_url: ${imageUrl}`);
    }

    const responseMimeType = response.headers.get("content-type") || "";
    const inferredFilename = inferFilenameFromUrl(imageUrl);
    const buffer = await readResponseBytes(response, {
      maxBytes: MAX_DIRECT_IMAGE_BYTES,
      tooLargeMessage: buildLargeImageInputMessage()
    });
    const mimeType = resolveRemoteImageMimeType({
      responseMimeType,
      bytes: buffer
    });

    if (!mimeType) {
      throw new HttpError(
        400,
        buildInvalidRemoteImageMessage(imageUrl, responseMimeType)
      );
    }

    const filename =
      inferredFilename === "remote-file"
        ? `image${inferExtensionFromMimeType(mimeType) || ".bin"}`
        : inferredFilename;

    return {
      filename,
      mimeType,
      bytes: buffer,
      source: "image_url"
    };
  }));
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

  const normalizedMessages = await Promise.all(messages.map(async (message) => {
    const text = extractTextContent(message.content);
    const [files, images] = await Promise.all([
      resolveFileParts({
        content: message.content,
        fileStore
      }),
      resolveImageParts({
        content: message.content
      })
    ]);

    return {
      role: message.role,
      text,
      files: [...files, ...images]
    };
  }));

  return {
    instructions,
    messages: normalizedMessages
  };
}

export async function normalizeChatCompletionInput({
  requestBody,
  fileStore
}) {
  const { instructions, messages } = splitInstructionsAndMessages(
    requestBody.messages,
    ""
  );

  const normalizedMessages = await Promise.all(messages
    .filter((message) => message.role !== "tool")
    .map(async (message) => {
    const text = extractTextContent(message.content ?? "");
    const [files, images] = await Promise.all([
      resolveFileParts({
        content: message.content ?? "",
        fileStore
      }),
      resolveImageParts({
        content: message.content ?? ""
      })
    ]);

    return {
      role: message.role,
      text,
      files: [...files, ...images]
    };
  }));

  return {
    instructions,
    messages: normalizedMessages
  };
}
