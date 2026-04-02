import path from "node:path";
import { ensureDir, readJson, writeJson } from "../lib/fs.js";

export class ResponseStore {
  constructor(dataDir) {
    this.path = path.join(dataDir, "responses.json");
    this.state = { responses: {} };
  }

  async init() {
    await ensureDir(path.dirname(this.path));
    this.state = await readJson(this.path, { responses: {} });
  }

  async set(record) {
    this.state.responses[record.id] = record;
    await writeJson(this.path, this.state);
    return record;
  }

  get(id) {
    return this.state.responses[id] ?? null;
  }
}
