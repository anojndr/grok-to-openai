import path from "node:path";
import { HttpError } from "../lib/errors.js";
import { sanitizeFilename } from "../lib/fs.js";
import { config } from "../config.js";

const DEFAULT_PIXELVAULT_API_URL = "https://api.pixelvault.dev/v1/images";
const PIXELVAULT_UPLOAD_ATTEMPTS = 3;
const PIXELVAULT_RETRY_DELAY_MS = 750;
const PIXELVAULT_HOSTS = ["img.pixelvault.dev", "pixelvault.dev"];
const PIXELVAULT_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const PIXELVAULT_MIN_EXPIRATION_SECONDS = 60;
const PIXELVAULT_MAX_EXPIRATION_SECONDS = 2592000;

function matchesHostname(hostname, domain) {
  const normalized = String(hostname || "").toLowerCase();
  return normalized === domain || normalized.endsWith(`.${domain}`);
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
    default:
      return ".bin";
  }
}

function inferFilenameFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    const filename = sanitizeFilename(path.basename(url.pathname) || "");
    return filename || null;
  } catch {
    return null;
  }
}

function inferUploadFilename(image, index, mimeType) {
  const filenameFromUrl = inferFilenameFromUrl(image?.url);
  if (filenameFromUrl) {
    return filenameFromUrl;
  }

  if (image?.title) {
    return `${sanitizeFilename(image.title)}${inferExtensionFromMimeType(mimeType)}`;
  }

  return `generated-image-${index + 1}${inferExtensionFromMimeType(mimeType)}`;
}

function toHttpError(message, details) {
  return new HttpError(502, details ? `${message}: ${details}` : message);
}

function toConfigurationError(message, details) {
  return new HttpError(500, details ? `${message}: ${details}` : message);
}

function toValidationError(message, details) {
  return new HttpError(400, details ? `${message}: ${details}` : message);
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) {
    return bytes;
  }

  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes);
  }

  return Buffer.from(bytes || "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeExpiration(expiration) {
  if (expiration == null || expiration === "") {
    return "";
  }

  const value = Number.parseInt(String(expiration), 10);
  if (!Number.isFinite(value)) {
    throw toConfigurationError(
      "PixelVault upload is not configured",
      "PIXELVAULT_EXPIRATION must be an integer number of seconds"
    );
  }

  if (
    value < PIXELVAULT_MIN_EXPIRATION_SECONDS ||
    value > PIXELVAULT_MAX_EXPIRATION_SECONDS
  ) {
    throw toConfigurationError(
      "PixelVault upload is not configured",
      `PIXELVAULT_EXPIRATION must be between ${PIXELVAULT_MIN_EXPIRATION_SECONDS} and ${PIXELVAULT_MAX_EXPIRATION_SECONDS} seconds`
    );
  }

  return String(value);
}

async function submitPixelVaultRequest(apiUrl, apiKey, form) {
  return fetch(apiUrl || DEFAULT_PIXELVAULT_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });
}

function extractErrorDetails(payload, fallback) {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  const message = payload.error?.message || payload.message;

  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }

  const code = payload.error?.code;
  if (typeof code === "string" && code.trim()) {
    return code.trim();
  }

  return fallback;
}

async function parsePixelVaultResponse(response) {
  const responseText = (await response.text()).trim();

  let payload = null;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw toHttpError(
      "PixelVault upload failed",
      extractErrorDetails(payload, responseText || `HTTP ${response.status}`)
    );
  }

  if (!responseText) {
    return {
      empty: true,
      url: null
    };
  }

  if (!payload || payload.data == null) {
    throw toHttpError(
      "PixelVault upload failed",
      extractErrorDetails(payload, responseText || "invalid JSON response")
    );
  }

  const hostedUrl = payload.data.url;

  if (!hostedUrl) {
    throw toHttpError("PixelVault upload failed", "missing hosted image URL");
  }

  try {
    return {
      empty: false,
      url: new URL(hostedUrl).toString()
    };
  } catch {
    throw toHttpError("PixelVault upload failed", hostedUrl);
  }
}

function normalizeMimeType(mimeType) {
  return String(mimeType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function resolveHostedImageMimeType(image, asset) {
  const assetMimeType = normalizeMimeType(
    asset?.mimeType || asset?.contentType || ""
  );

  if (
    assetMimeType &&
    assetMimeType !== "application/octet-stream" &&
    !assetMimeType.startsWith("image/")
  ) {
    throw toHttpError(
      "Protected Grok image fetch returned non-image data",
      assetMimeType
    );
  }

  return image?.mimeType || assetMimeType || "application/octet-stream";
}

export function isPixelVaultUrl(urlString) {
  try {
    const url = new URL(urlString);
    return PIXELVAULT_HOSTS.some((domain) => matchesHostname(url.hostname, domain));
  } catch {
    return false;
  }
}

function isGrokAssetUrl(urlString) {
  try {
    const url = new URL(urlString);
    return matchesHostname(url.hostname, "assets.grok.com");
  } catch {
    return false;
  }
}

function shouldRehostImage(image) {
  if (!image?.url || isPixelVaultUrl(image.url)) {
    return false;
  }

  if (image.sourceUrlType) {
    return image.sourceUrlType === "grok_asset";
  }

  const action = String(image.action || "").toLowerCase();
  if (action === "generate" || action === "edit") {
    return true;
  }

  return isGrokAssetUrl(image.url);
}

export class PixelVaultClient {
  constructor(config = {}) {
    this.apiUrl = config.pixelvaultApiUrl || DEFAULT_PIXELVAULT_API_URL;
    this.apiKey = config.pixelvaultApiKey || "";
    this.expiration = normalizeExpiration(config.pixelvaultExpiration);
  }

  async uploadFile({ filename, mimeType, bytes }) {
    if (!this.apiKey) {
      throw toConfigurationError(
        "PixelVault upload is not configured",
        "PIXELVAULT_API_KEY is missing"
      );
    }

    const normalizedBytes = toBuffer(bytes);
    if (!normalizedBytes.length) {
      throw toHttpError("PixelVault upload failed", "empty file payload");
    }
    if (normalizedBytes.length > PIXELVAULT_MAX_UPLOAD_BYTES) {
      throw toValidationError(
        "PixelVault upload failed",
        "image exceeds 32 MB limit"
      );
    }

    let lastRetriableError = null;

    for (let attempt = 0; attempt < PIXELVAULT_UPLOAD_ATTEMPTS; attempt += 1) {
      const form = new FormData();
      const sanitizedFilename = sanitizeFilename(filename || "upload.bin");
      form.set(
        "file",
        new File([normalizedBytes], sanitizedFilename, {
          type: mimeType || "application/octet-stream"
        })
      );
      if (this.expiration) {
        form.set("expires_in", this.expiration);
      }

      let response;
      try {
        response = await submitPixelVaultRequest(
          this.apiUrl,
          this.apiKey,
          form
        );
      } catch (error) {
        lastRetriableError = toHttpError(
          "PixelVault upload failed",
          error instanceof Error ? error.message : String(error)
        );
        if (attempt + 1 < PIXELVAULT_UPLOAD_ATTEMPTS) {
          await sleep(PIXELVAULT_RETRY_DELAY_MS);
          continue;
        }

        throw lastRetriableError;
      }

      const parsed = await parsePixelVaultResponse(response);
      if (parsed.empty) {
        lastRetriableError = toHttpError("PixelVault upload failed", "empty response");
        if (attempt + 1 < PIXELVAULT_UPLOAD_ATTEMPTS) {
          await sleep(PIXELVAULT_RETRY_DELAY_MS);
          continue;
        }

        throw lastRetriableError;
      }

      return parsed.url;
    }

    throw lastRetriableError ?? toHttpError("PixelVault upload failed");
  }

  async verifyFile(url) {
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Range: "bytes=0-0"
        }
      });
    } catch (error) {
      if (config.verbose) {
        console.warn(
          `PixelVault upload verification fetch failed: ${
            error instanceof Error ? error.message : String(error)
          }. Bypassing verification.`
        );
      }
      return url;
    }

    if (!response.ok) {
      if (config.verbose) {
        console.warn(
          `PixelVault upload verification returned HTTP status ${response.status}. Bypassing verification.`
        );
      }
      return url;
    }

    try {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) {
        throw toHttpError(
          "PixelVault upload verification failed",
          "uploaded file is empty"
        );
      }
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      if (config.verbose) {
        console.warn(
          `PixelVault upload verification failed to read response array buffer: ${
            error instanceof Error ? error.message : String(error)
          }. Bypassing verification.`
        );
      }
      return url;
    }

    return url;
  }
}

export async function rehostGeneratedImages({
  images = [],
  loadSourceImage,
  uploadClient
}) {
  if (!Array.isArray(images) || images.length === 0) {
    return [];
  }

  if (typeof loadSourceImage !== "function") {
    return images;
  }

  if (!uploadClient || typeof uploadClient.uploadFile !== "function") {
    throw new TypeError("uploadClient.uploadFile is required");
  }

  const uploadsBySourceUrl = new Map();

  return Promise.all(
    images.map(async (image, index) => {
      if (!shouldRehostImage(image)) {
        return image;
      }

      const sourceUrl = image.url;
      let uploadPromise = uploadsBySourceUrl.get(sourceUrl);

      if (!uploadPromise) {
        uploadPromise = (async () => {
          let asset;
          try {
            asset = await loadSourceImage(image, index);
          } catch (error) {
            throw toHttpError(
              "Unable to fetch Grok-generated image for PixelVault upload",
              error instanceof Error ? error.message : String(error)
            );
          }

          const bytes = toBuffer(asset?.bytes);
          if (!bytes.length) {
            throw toHttpError(
              "Unable to fetch Grok-generated image for PixelVault upload",
              sourceUrl
            );
          }

          const mimeType = resolveHostedImageMimeType(image, asset);
          const hostedUrl = await uploadClient.uploadFile({
            filename: inferUploadFilename(image, index, mimeType),
            mimeType,
            bytes
          });

          return {
            bytes,
            mimeType,
            url: hostedUrl
          };
        })();

        uploadsBySourceUrl.set(sourceUrl, uploadPromise);
      }

      const hostedImage = await uploadPromise;

      return {
        ...image,
        bytes: hostedImage.bytes,
        mimeType: hostedImage.mimeType,
        sourceUrl,
        url: hostedImage.url
      };
    })
  );
}