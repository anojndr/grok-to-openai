export const JSON_BODY_LIMIT = "8mb";
export const MAX_DIRECT_FILE_BYTES = 6 * 1024 * 1024;
export const MAX_DIRECT_IMAGE_BYTES = 6 * 1024 * 1024;
export const UPLOAD_FILE_SIZE_LIMIT = 50 * 1024 * 1024;

function formatBinaryMegabytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

export function buildLargeFileInputMessage() {
  return (
    "Large file inputs must be uploaded via /v1/files and referenced with file_id. " +
    `Direct file_data and file_url inputs are capped at ${formatBinaryMegabytes(
      MAX_DIRECT_FILE_BYTES
    )}.`
  );
}

export function buildLargeImageInputMessage() {
  return (
    "Large image inputs are capped before they are fetched into memory. " +
    `Provide a smaller image_url or resize the image to stay under ${formatBinaryMegabytes(
      MAX_DIRECT_IMAGE_BYTES
    )}.`
  );
}

export function buildJsonBodyTooLargeMessage() {
  return (
    `JSON request bodies are capped at ${JSON_BODY_LIMIT}. ` +
    "Upload large files via /v1/files and reference them with file_id instead of embedding them inline."
  );
}

export function buildUploadedFileTooLargeMessage() {
  return `Files uploaded to /v1/files are capped at ${formatBinaryMegabytes(
    UPLOAD_FILE_SIZE_LIMIT
  )}.`;
}
