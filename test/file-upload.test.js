import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFileForGrokUpload,
  uploadFilesToGrok
} from "../src/grok/file-upload.js";

test("normalizeFileForGrokUpload preserves existing Buffer instances for binary uploads", () => {
  const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const normalized = normalizeFileForGrokUpload({
    filename: "photo.bin",
    mimeType: "application/octet-stream",
    bytes
  });

  assert.equal(normalized.mimeType, "application/octet-stream");
  assert.equal(normalized.bytes, bytes);
});

test("normalizeFileForGrokUpload decodes data URL-wrapped CSV payloads before upload", () => {
  const csvText = "name,score\nAna,10\nBen,12\n";
  const bytes = Buffer.from(
    `data:text/csv;charset=utf-8;base64,${Buffer.from(csvText, "utf8").toString("base64")}`,
    "utf8"
  );

  const normalized = normalizeFileForGrokUpload({
    filename: "scores.csv",
    mimeType: "application/octet-stream",
    bytes
  });

  assert.equal(normalized.mimeType, "text/csv");
  assert.equal(normalized.bytes.toString("utf8"), csvText);
});

test("uploadFilesToGrok uploads attachments concurrently while preserving order", async () => {
  let activeUploads = 0;
  let maximumActiveUploads = 0;
  const accountClient = {
    async uploadFile({ filename }) {
      activeUploads += 1;
      maximumActiveUploads = Math.max(maximumActiveUploads, activeUploads);
      await new Promise((resolve) =>
        setTimeout(resolve, filename === "file-1.txt" ? 15 : 5)
      );
      activeUploads -= 1;
      return { fileMetadataId: `metadata-${filename}` };
    }
  };
  const files = Array.from({ length: 5 }, (_, index) => ({
    filename: `file-${index}.txt`,
    mimeType: "text/plain",
    bytes: Buffer.from(String(index))
  }));

  const uploadedIds = await uploadFilesToGrok(accountClient, files, {
    concurrency: 2
  });

  assert.equal(maximumActiveUploads, 2);
  assert.deepEqual(
    uploadedIds,
    files.map((file) => `metadata-${file.filename}`)
  );
});

test("uploadFilesToGrok rejects uploads without metadata ids", async () => {
  await assert.rejects(
    uploadFilesToGrok(
      {
        async uploadFile() {
          return {};
        }
      },
      [
        {
          filename: "missing.txt",
          mimeType: "text/plain",
          bytes: Buffer.from("missing")
        }
      ]
    ),
    (error) => error?.status === 502
  );
});
