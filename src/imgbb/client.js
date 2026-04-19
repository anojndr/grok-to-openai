import path from "node:path";
import { HttpError } from "../lib/errors.js";
import { sanitizeFilename } from "../lib/fs.js";

const DEFAULT_IMGBB_API_URL = "https://api.imgbb.com/1/upload";
const IMGBB_UPLOAD_ATTEMPTS = 3;
const IMGBB_RETRY_DELAY_MS = 750;
const IMGBB_HOSTS = ["ibb.co", "i.ibb.co", "imgbb.com"];
const IMGBB_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const IMGBB_MIN_EXPIRATION_SECONDS = 60;
const IMGBB_MAX_EXPIRATION_SECONDS = 15552000;

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
      "Imgbb upload is not configured",
      "IMGBB_EXPIRATION must be an integer number of seconds"
    );
  }

  if (
    value < IMGBB_MIN_EXPIRATION_SECONDS ||
    value > IMGBB_MAX_EXPIRATION_SECONDS
  ) {
    throw toConfigurationError(
      "Imgbb upload is not configured",
      `IMGBB_EXPIRATION must be between ${IMGBB_MIN_EXPIRATION_SECONDS} and ${IMGBB_MAX_EXPIRATION_SECONDS} seconds`
    );
  }

  return String(value);
}

function buildUploadUrl(apiUrl, apiKey, expiration) {
  const url = new URL(apiUrl || DEFAULT_IMGBB_API_URL);
  url.searchParams.set("key", apiKey);
  if (expiration) {
    url.searchParams.set("expiration", expiration);
  }
  return url.toString();
}

async function submitImgbbRequest(apiUrl, apiKey, expiration, form) {
  return fetch(buildUploadUrl(apiUrl, apiKey, expiration), {
    method: "POST",
    body: form
  });
}

function extractErrorDetails(payload, fallback) {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  const message =
    payload.error?.message ||
    payload.error?.context ||
    payload.status_txt ||
    payload.message;

  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }

  return fallback;
}

async function parseImgbbResponse(response) {
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
      "Imgbb upload failed",
      extractErrorDetails(payload, responseText || `HTTP ${response.status}`)
    );
  }

  if (!responseText) {
    return {
      empty: true,
      url: null
    };
  }

  if (!payload || payload.success !== true) {
    throw toHttpError(
      "Imgbb upload failed",
      extractErrorDetails(payload, responseText || "invalid JSON response")
    );
  }

  const hostedUrl =
    payload.data?.url || payload.data?.image?.url || payload.data?.display_url;

  if (!hostedUrl) {
    throw toHttpError("Imgbb upload failed", "missing hosted image URL");
  }

  try {
    return {
      empty: false,
      url: new URL(hostedUrl).toString()
    };
  } catch {
    throw toHttpError("Imgbb upload failed", hostedUrl);
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

export function isImgbbUrl(urlString) {
  try {
    const url = new URL(urlString);
    return IMGBB_HOSTS.some((domain) => matchesHostname(url.hostname, domain));
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
  if (!image?.url || isImgbbUrl(image.url)) {
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

export class ImgbbClient {
  constructor(config = {}) {
    this.apiUrl = config.imgbbApiUrl || DEFAULT_IMGBB_API_URL;
    this.apiKey = config.imgbbApiKey || "";
    this.expiration = normalizeExpiration(config.imgbbExpiration);
  }

  async uploadFile({ filename, mimeType, bytes }) {
    if (!this.apiKey) {
      throw toConfigurationError(
        "Imgbb upload is not configured",
        "IMGBB_API_KEY is missing"
      );
    }

    const normalizedBytes = toBuffer(bytes);
    if (!normalizedBytes.length) {
      throw toHttpError("Imgbb upload failed", "empty file payload");
    }
    if (normalizedBytes.length > IMGBB_MAX_UPLOAD_BYTES) {
      throw toValidationError(
        "Imgbb upload failed",
        "image exceeds 32 MB limit"
      );
    }

    let lastRetriableError = null;

    for (let attempt = 0; attempt < IMGBB_UPLOAD_ATTEMPTS; attempt += 1) {
      const form = new FormData();
      const sanitizedFilename = sanitizeFilename(filename || "upload.bin");
      form.set(
        "image",
        new File([normalizedBytes], sanitizedFilename, {
          type: mimeType || "application/octet-stream"
        })
      );
      const uploadName = sanitizeFilename(path.parse(sanitizedFilename).name);
      if (uploadName) {
        form.set("name", uploadName);
      }

      let response;
      try {
        response = await submitImgbbRequest(
          this.apiUrl,
          this.apiKey,
          this.expiration,
          form
        );
      } catch (error) {
        lastRetriableError = toHttpError(
          "Imgbb upload failed",
          error instanceof Error ? error.message : String(error)
        );
        if (attempt + 1 < IMGBB_UPLOAD_ATTEMPTS) {
          await sleep(IMGBB_RETRY_DELAY_MS);
          continue;
        }

        throw lastRetriableError;
      }

      const parsed = await parseImgbbResponse(response);
      if (parsed.empty) {
        lastRetriableError = toHttpError("Imgbb upload failed", "empty response");
        if (attempt + 1 < IMGBB_UPLOAD_ATTEMPTS) {
          await sleep(IMGBB_RETRY_DELAY_MS);
          continue;
        }

        throw lastRetriableError;
      }

      return parsed.url;
    }

    throw lastRetriableError ?? toHttpError("Imgbb upload failed");
  }

  async verifyFile(url) {
    let response;
    try {
      response = await fetch(url, {
        headers: {
          Range: "bytes=0-0"
        }
      });
    } catch (error) {
      throw toHttpError(
        "Imgbb upload verification failed",
        error instanceof Error ? error.message : String(error)
      );
    }

    if (!response.ok) {
      throw toHttpError(
        "Imgbb upload verification failed",
        `HTTP ${response.status}`
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw toHttpError(
        "Imgbb upload verification failed",
        "uploaded file is empty"
      );
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
              "Unable to fetch Grok-generated image for Imgbb upload",
              error instanceof Error ? error.message : String(error)
            );
          }

          const bytes = toBuffer(asset?.bytes);
          if (!bytes.length) {
            throw toHttpError(
              "Unable to fetch Grok-generated image for Imgbb upload",
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
