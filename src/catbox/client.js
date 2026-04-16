import path from "node:path";
import { HttpError } from "../lib/errors.js";
import { sanitizeFilename } from "../lib/fs.js";

const DEFAULT_CATBOX_API_URL = "https://catbox.moe/user/api.php";
const CATBOX_HOSTS = new Set(["catbox.moe", "files.catbox.moe"]);
const CATBOX_UPLOAD_ATTEMPTS = 3;
const CATBOX_RETRY_DELAY_MS = 750;

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

async function submitCatboxRequest(apiUrl, form) {
  return fetch(apiUrl, {
    method: "POST",
    body: form
  });
}

async function parseCatboxResponse(response) {
  const responseText = (await response.text()).trim();
  if (!response.ok) {
    throw toHttpError(
      "Catbox upload failed",
      responseText || `HTTP ${response.status}`
    );
  }

  if (!responseText) {
    return {
      empty: true,
      url: null
    };
  }

  if (/^error\b/i.test(responseText)) {
    throw toHttpError("Catbox upload failed", responseText);
  }

  try {
    return {
      empty: false,
      url: new URL(responseText).toString()
    };
  } catch {
    throw toHttpError("Catbox upload failed", responseText);
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

export function isCatboxUrl(urlString) {
  try {
    const url = new URL(urlString);
    return CATBOX_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export class CatboxClient {
  constructor(config = {}) {
    this.apiUrl = config.catboxApiUrl || DEFAULT_CATBOX_API_URL;
    this.userhash = config.catboxUserhash || "";
  }

  async uploadUrl({ url }) {
    let lastRetriableError = null;

    for (let attempt = 0; attempt < CATBOX_UPLOAD_ATTEMPTS; attempt += 1) {
      const form = new FormData();
      form.set("reqtype", "urlupload");
      if (this.userhash) {
        form.set("userhash", this.userhash);
      }
      form.set("url", url);

      let response;
      try {
        response = await submitCatboxRequest(this.apiUrl, form);
      } catch (error) {
        lastRetriableError = toHttpError(
          "Catbox upload failed",
          error instanceof Error ? error.message : String(error)
        );
        if (attempt + 1 < CATBOX_UPLOAD_ATTEMPTS) {
          await sleep(CATBOX_RETRY_DELAY_MS);
          continue;
        }

        throw lastRetriableError;
      }

      const parsed = await parseCatboxResponse(response);
      if (parsed.empty) {
        lastRetriableError = toHttpError("Catbox upload failed", "empty response");
        if (attempt + 1 < CATBOX_UPLOAD_ATTEMPTS) {
          await sleep(CATBOX_RETRY_DELAY_MS);
          continue;
        }

        throw lastRetriableError;
      }

      return parsed.url;
    }

    throw lastRetriableError ?? toHttpError("Catbox upload failed");
  }

  async uploadFile({ filename, mimeType, bytes }) {
    const normalizedBytes = toBuffer(bytes);
    if (!normalizedBytes.length) {
      throw toHttpError("Catbox upload failed", "empty file payload");
    }

    let lastRetriableError = null;

    for (let attempt = 0; attempt < CATBOX_UPLOAD_ATTEMPTS; attempt += 1) {
      const form = new FormData();
      form.set("reqtype", "fileupload");
      if (this.userhash) {
        form.set("userhash", this.userhash);
      }
      form.set(
        "fileToUpload",
        new File([normalizedBytes], sanitizeFilename(filename || "upload.bin"), {
          type: mimeType || "application/octet-stream"
        })
      );

      let response;
      try {
        response = await submitCatboxRequest(this.apiUrl, form);
      } catch (error) {
        lastRetriableError = toHttpError(
          "Catbox upload failed",
          error instanceof Error ? error.message : String(error)
        );
        if (attempt + 1 < CATBOX_UPLOAD_ATTEMPTS) {
          await sleep(CATBOX_RETRY_DELAY_MS);
          continue;
        }

        throw lastRetriableError;
      }

      const parsed = await parseCatboxResponse(response);
      if (parsed.empty) {
        lastRetriableError = toHttpError("Catbox upload failed", "empty response");
        if (attempt + 1 < CATBOX_UPLOAD_ATTEMPTS) {
          await sleep(CATBOX_RETRY_DELAY_MS);
          continue;
        }

        throw lastRetriableError;
      }

      return parsed.url;
    }

    throw lastRetriableError ?? toHttpError("Catbox upload failed");
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
        "Catbox upload verification failed",
        error instanceof Error ? error.message : String(error)
      );
    }

    if (!response.ok) {
      throw toHttpError(
        "Catbox upload verification failed",
        `HTTP ${response.status}`
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw toHttpError(
        "Catbox upload verification failed",
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
      if (!image?.url || isCatboxUrl(image.url)) {
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
              "Unable to fetch Grok-generated image for Catbox upload",
              error instanceof Error ? error.message : String(error)
            );
          }

          const bytes = toBuffer(asset?.bytes);
          if (!bytes.length) {
            throw toHttpError(
              "Unable to fetch Grok-generated image for Catbox upload",
              sourceUrl
            );
          }

          const mimeType = resolveHostedImageMimeType(image, asset);
          const catboxUrl = await uploadClient.uploadFile({
            filename: inferUploadFilename(image, index, mimeType),
            mimeType,
            bytes
          });

          return {
            bytes,
            mimeType,
            url: catboxUrl
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
