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

test("FileStore persists file metadata incrementally without rewriting a global index", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "grok-to-openai-file-store-")
  );

  try {
    const store = new FileStore(dataDir);
    await store.init();

    const created = await store.create({
      filename: "notes.txt",
      bytes: Buffer.from("hello"),
      purpose: "user_data",
      mimeType: "text/plain"
    });

    const metadataPath = path.join(dataDir, "file-metadata", `${created.id}.json`);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));

    assert.equal(metadata.id, created.id);
    assert.equal(metadata.filename, "notes.txt");
    await assert.rejects(fs.access(path.join(dataDir, "files-index.json")));

    const reloadedStore = new FileStore(dataDir);
    await reloadedStore.init();

    const stored = await reloadedStore.getWithContent(created.id);
    assert.equal(stored?.record.filename, "notes.txt");
    assert.equal(stored?.content.toString("utf8"), "hello");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("FileStore does not rewrite a legacy global index when new files are added", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "grok-to-openai-file-store-")
  );
  const filesDir = path.join(dataDir, "files");
  const legacyFilePath = path.join(filesDir, "file_legacy-legacy.txt");
  const legacyRecord = {
    id: "file_legacy",
    object: "file",
    bytes: 6,
    created_at: 1,
    filename: "legacy.txt",
    purpose: "user_data",
    mime_type: "text/plain",
    status: "processed",
    path: legacyFilePath
  };
  const legacyIndexPath = path.join(dataDir, "files-index.json");

  await fs.mkdir(filesDir, { recursive: true });
  await fs.writeFile(legacyFilePath, "legacy");
  await fs.writeFile(
    legacyIndexPath,
    `${JSON.stringify({ files: { [legacyRecord.id]: legacyRecord } })}\n`
  );

  try {
    const legacyIndexBefore = await fs.readFile(legacyIndexPath, "utf8");
    const store = new FileStore(dataDir);
    await store.init();

    const created = await store.create({
      filename: "fresh.txt",
      bytes: Buffer.from("fresh"),
      purpose: "user_data",
      mimeType: "text/plain"
    });

    assert.equal(await fs.readFile(legacyIndexPath, "utf8"), legacyIndexBefore);

    const reloadedStore = new FileStore(dataDir);
    await reloadedStore.init();

    assert.equal((await reloadedStore.get(legacyRecord.id))?.filename, "legacy.txt");
    assert.equal((await reloadedStore.get(created.id))?.filename, "fresh.txt");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
