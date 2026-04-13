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
