import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJson } from "../src/lib/fs.js";

test("writeJson keeps concurrent writes atomic and leaves no temp files", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "grok-json-write-"));
  const filePath = path.join(dataDir, "state.json");
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const records = Array.from({ length: 32 }, (_, index) => ({
    index,
    payload: String(index).repeat(64 * 1024)
  }));
  await Promise.all(records.map((record) => writeJson(filePath, record)));

  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(persisted, records[persisted.index]);
  assert.deepEqual(
    (await fs.readdir(dataDir)).filter((name) => name.endsWith(".tmp")),
    []
  );
});
