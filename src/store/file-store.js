import fs from "node:fs/promises";
import path from "node:path";
import { createId, unixTimestampSeconds } from "../lib/ids.js";
import { ensureDir, readJson, sanitizeFilename, writeJson } from "../lib/fs.js";

export class FileStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filesDir = path.join(dataDir, "files");
    this.indexPath = path.join(dataDir, "files-index.json");
    this.index = { files: {} };
  }

  async init() {
    await ensureDir(this.filesDir);
    this.index = await readJson(this.indexPath, { files: {} });
  }

  async saveIndex() {
    await writeJson(this.indexPath, this.index);
  }

  async create({ filename, bytes, purpose = "user_data", mimeType = "application/octet-stream" }) {
    const id = createId("file");
    const safeName = sanitizeFilename(filename || "upload.bin");
    const filePath = path.join(this.filesDir, `${id}-${safeName}`);
    const createdAt = unixTimestampSeconds();

    await fs.writeFile(filePath, bytes);

    const record = {
      id,
      object: "file",
      bytes: bytes.length,
      created_at: createdAt,
      filename: safeName,
      purpose,
      mime_type: mimeType,
      status: "processed",
      path: filePath
    };

    this.index.files[id] = record;
    await this.saveIndex();

    return this.toOpenAIFile(record);
  }

  async get(id) {
    const record = this.index.files[id];
    return record ? this.toOpenAIFile(record) : null;
  }

  async getContent(id) {
    const record = this.index.files[id];
    if (!record) {
      return null;
    }

    return fs.readFile(record.path);
  }

  async getRecord(id) {
    return this.index.files[id] ?? null;
  }

  toOpenAIFile(record) {
    return {
      id: record.id,
      object: "file",
      bytes: record.bytes,
      created_at: record.created_at,
      filename: record.filename,
      purpose: record.purpose,
      status: record.status
    };
  }
}
