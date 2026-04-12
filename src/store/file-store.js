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

  buildRecord({
    id,
    filename,
    bytes,
    createdAt,
    purpose = "user_data",
    mimeType = "application/octet-stream",
    filePath
  }) {
    return {
      id,
      object: "file",
      bytes,
      created_at: createdAt,
      filename,
      purpose,
      mime_type: mimeType,
      status: "processed",
      path: filePath
    };
  }

  async create({ filename, bytes, purpose = "user_data", mimeType = "application/octet-stream" }) {
    const id = createId("file");
    const safeName = sanitizeFilename(filename || "upload.bin");
    const filePath = path.join(this.filesDir, `${id}-${safeName}`);
    const createdAt = unixTimestampSeconds();
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

    await fs.writeFile(filePath, content);

    const record = this.buildRecord({
      id,
      filename: safeName,
      bytes: content.length,
      createdAt,
      purpose,
      mimeType,
      filePath
    });

    this.index.files[id] = record;
    await this.saveIndex();

    return this.toOpenAIFile(record);
  }

  async createFromPath({
    filename,
    sourcePath,
    purpose = "user_data",
    mimeType = "application/octet-stream",
    size
  }) {
    const id = createId("file");
    const safeName = sanitizeFilename(filename || "upload.bin");
    const filePath = path.join(this.filesDir, `${id}-${safeName}`);
    const createdAt = unixTimestampSeconds();
    const bytes =
      Number.isFinite(size) && size >= 0 ? size : (await fs.stat(sourcePath)).size;

    try {
      await fs.rename(sourcePath, filePath);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EXDEV") {
        await fs.copyFile(sourcePath, filePath);
        await fs.rm(sourcePath, { force: true });
      } else {
        throw error;
      }
    }

    const record = this.buildRecord({
      id,
      filename: safeName,
      bytes,
      createdAt,
      purpose,
      mimeType,
      filePath
    });

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
