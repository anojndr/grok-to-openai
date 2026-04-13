import fs from "node:fs/promises";
import path from "node:path";
import { createId, unixTimestampSeconds } from "../lib/ids.js";
import { ensureDir, readJson, sanitizeFilename, writeJson } from "../lib/fs.js";

export class FileStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filesDir = path.join(dataDir, "files");
    this.metadataDir = path.join(dataDir, "file-metadata");
    this.indexPath = path.join(dataDir, "files-index.json");
    this.index = { files: {} };
  }

  async init() {
    await Promise.all([
      ensureDir(this.filesDir),
      ensureDir(this.metadataDir)
    ]);

    const [legacyIndex, metadataIndex] = await Promise.all([
      readJson(this.indexPath, { files: {} }),
      this.readMetadataIndex()
    ]);

    this.index = {
      files: {
        ...(legacyIndex.files ?? {}),
        ...(metadataIndex.files ?? {})
      }
    };
  }

  async readMetadataIndex() {
    const entries = await fs.readdir(this.metadataDir, { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) =>
          readJson(path.join(this.metadataDir, entry.name), null)
        )
    );

    return {
      files: Object.fromEntries(
        records
          .filter((record) => record?.id)
          .map((record) => [record.id, record])
      )
    };
  }

  metadataPathForId(id) {
    return path.join(this.metadataDir, `${id}.json`);
  }

  async saveRecord(record) {
    await writeJson(this.metadataPathForId(record.id), record);
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

    await this.saveRecord(record);
    this.index.files[id] = record;

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

    await this.saveRecord(record);
    this.index.files[id] = record;

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

  async getWithContent(id) {
    const record = this.index.files[id];
    if (!record) {
      return null;
    }

    return {
      record,
      content: await fs.readFile(record.path)
    };
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
