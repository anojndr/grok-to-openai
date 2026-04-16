import { createId } from "../lib/ids.js";

const DEFAULT_STAGE_TTL_MS = 10 * 60 * 1000;

export class CatboxStageStore {
  constructor({ ttlMs = DEFAULT_STAGE_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  sweepExpired(now = Date.now()) {
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(token);
      }
    }
  }

  create({ bytes, mimeType, filename }) {
    this.sweepExpired();

    const token = createId("catboxstage");
    const entry = {
      token,
      bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || ""),
      mimeType: mimeType || "application/octet-stream",
      filename: filename || "upload.bin",
      expiresAt: Date.now() + this.ttlMs
    };

    this.entries.set(token, entry);
    return entry;
  }

  get(token) {
    this.sweepExpired();
    return this.entries.get(token) ?? null;
  }

  delete(token) {
    this.entries.delete(token);
  }
}
