export const UPLOAD_FILE_SIZE_LIMIT = 50 * 1024 * 1024;
export const MAX_DIRECT_FILE_BYTES = UPLOAD_FILE_SIZE_LIMIT;
export const MAX_DIRECT_IMAGE_BYTES = UPLOAD_FILE_SIZE_LIMIT;
export const JSON_BODY_LIMIT =
  Math.ceil((MAX_DIRECT_FILE_BYTES * 4) / 3) + 4 * 1024 * 1024;

function formatBinaryMegabytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

export function buildLargeFileInputMessage() {
  return (
    `File inputs are capped at ${formatBinaryMegabytes(
      MAX_DIRECT_FILE_BYTES
    )}. ` +
    "Use /v1/files and file_id to avoid large inline JSON payloads."
  );
}

export function buildLargeImageInputMessage() {
  return (
    `Image inputs are capped at ${formatBinaryMegabytes(
      MAX_DIRECT_IMAGE_BYTES
    )}. ` +
    "Use a remote image_url instead of inline base64 when possible to avoid large JSON payloads."
  );
}

export function buildJsonBodyTooLargeMessage() {
  return (
    `JSON request bodies are capped at ${formatBinaryMegabytes(JSON_BODY_LIMIT)}. ` +
    "Upload large files via /v1/files and reference them with file_id instead of embedding them inline."
  );
}

export function buildUploadedFileTooLargeMessage() {
  return `Files uploaded to /v1/files are capped at ${formatBinaryMegabytes(
    UPLOAD_FILE_SIZE_LIMIT
  )}.`;
}
