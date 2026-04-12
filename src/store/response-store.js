import path from "node:path";
import { ensureDir, readJson, sanitizeFilename, writeJson } from "../lib/fs.js";

export class ResponseStore {
  constructor(dataDir) {
    this.responsesDir = path.join(dataDir, "responses");
    this.legacyPath = path.join(dataDir, "responses.json");
  }

  async init() {
    await ensureDir(this.responsesDir);
  }

  async set(record) {
    await writeJson(this.getRecordPath(record.id), record);
    return record;
  }

  async get(id) {
    const record = await readJson(this.getRecordPath(id), null);
    if (record) {
      return record;
    }

    const legacyRecord = await this.getLegacyRecord(id);
    if (!legacyRecord) {
      return null;
    }

    await writeJson(this.getRecordPath(id), legacyRecord);
    return legacyRecord;
  }

  getRecordPath(id) {
    return path.join(this.responsesDir, `${sanitizeFilename(id)}.json`);
  }

  async getLegacyRecord(id) {
    const state = await readJson(this.legacyPath, null);
    return state?.responses?.[id] ?? null;
  }
}
