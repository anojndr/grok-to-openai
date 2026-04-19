import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFileForGrokUpload } from "../src/grok/file-upload.js";

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
