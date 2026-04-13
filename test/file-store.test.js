import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../src/store/file-store.js";

test("FileStore moves temp uploads into permanent storage without re-reading them into memory first", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "grok-to-openai-file-store-")
  );
  const tmpDir = path.join(dataDir, "tmp");
  const uploadPath = path.join(tmpDir, "incoming.bin");

  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(uploadPath, "hello");

  try {
    const store = new FileStore(dataDir);
    await store.init();

    const created = await store.createFromPath({
      filename: "bad file?.txt",
      sourcePath: uploadPath,
      purpose: "user_data",
      mimeType: "text/plain"
    });

    assert.match(created.id, /^file_/);
    assert.equal(created.filename, "bad_file_.txt");
    assert.equal(created.bytes, 5);
    await assert.rejects(fs.access(uploadPath));

    const stored = await store.getWithContent(created.id);
    assert.equal(stored?.record.filename, "bad_file_.txt");
    assert.equal(stored?.record.mime_type, "text/plain");
    assert.equal(stored?.content.toString("utf8"), "hello");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
