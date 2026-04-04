import path from "node:path";

const TEXT_EXTENSION_MIME_TYPES = new Map([
  [".csv", "text/csv"],
  [".txt", "text/plain"],
  [".tsv", "text/tab-separated-values"]
]);

const TEXT_MIME_ALIASES = new Map([
  ["application/csv", "text/csv"],
  ["application/tab-separated-values", "text/tab-separated-values"]
]);

function parseMimeType(mimeType = "") {
  const [type = "", ...parameters] = String(mimeType).split(";");
  let charset = "";

  for (const parameter of parameters) {
    const match = /^\s*charset\s*=\s*"?([^";]+)"?\s*$/i.exec(parameter);
    if (match) {
      charset = match[1].trim().toLowerCase();
      break;
    }
  }

  return {
    baseMimeType: type.trim().toLowerCase(),
    charset
  };
}

function normalizeCharset(charset) {
  const normalized = charset.replace(/[_\s]/g, "").toLowerCase();

  switch (normalized) {
    case "utf8":
      return "utf-8";
    case "utf16":
    case "utf16le":
    case "ucs2":
    case "ucs-2":
      return "utf-16le";
    case "utf16be":
      return "utf-16be";
    default:
      return charset.toLowerCase();
  }
}

function inferTextMimeType(filename, baseMimeType) {
  const extension = path.extname(filename || "").toLowerCase();
  if (TEXT_EXTENSION_MIME_TYPES.has(extension)) {
    return TEXT_EXTENSION_MIME_TYPES.get(extension);
  }

  if (baseMimeType.startsWith("text/")) {
    return baseMimeType;
  }

  if (TEXT_MIME_ALIASES.has(baseMimeType)) {
    return TEXT_MIME_ALIASES.get(baseMimeType);
  }

  if (baseMimeType === "application/vnd.ms-excel" && extension === ".csv") {
    return "text/csv";
  }

  return "";
}

function detectBomEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf-16le";
  }

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf-16be";
  }

  return "";
}

function looksLikeUtf16(bytes, zeroByteOffset) {
  const pairCount = Math.min(Math.floor(bytes.length / 2), 32);
  if (pairCount < 2) {
    return false;
  }

  let zeroCount = 0;

  for (let index = 0; index < pairCount; index += 1) {
    if (bytes[index * 2 + zeroByteOffset] === 0x00) {
      zeroCount += 1;
    }
  }

  return zeroCount / pairCount >= 0.3;
}

function guessEncoding(bytes) {
  const bomEncoding = detectBomEncoding(bytes);
  if (bomEncoding) {
    return bomEncoding;
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf-8";
  } catch {}

  if (looksLikeUtf16(bytes, 1)) {
    return "utf-16le";
  }

  if (looksLikeUtf16(bytes, 0)) {
    return "utf-16be";
  }

  return "windows-1252";
}

function decodeText(bytes, encoding) {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return null;
  }
}

export function normalizeFileForGrokUpload({ filename, mimeType, bytes }) {
  const buffer = Buffer.from(bytes);
  const { baseMimeType, charset } = parseMimeType(mimeType);
  const textMimeType = inferTextMimeType(filename, baseMimeType);

  if (!textMimeType) {
    return {
      filename,
      mimeType: mimeType || "application/octet-stream",
      bytes: buffer
    };
  }

  const explicitEncoding = charset ? normalizeCharset(charset) : "";
  const decodedText =
    (explicitEncoding && decodeText(buffer, explicitEncoding)) ||
    decodeText(buffer, guessEncoding(buffer));

  if (decodedText == null) {
    return {
      filename,
      mimeType: textMimeType,
      bytes: buffer
    };
  }

  return {
    filename,
    mimeType: textMimeType,
    bytes: Buffer.from(decodedText, "utf8")
  };
}
