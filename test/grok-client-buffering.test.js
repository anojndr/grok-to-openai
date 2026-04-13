import test from "node:test";
import assert from "node:assert/strict";
import { GrokClient } from "../src/grok/client.js";

function createClient() {
  const requests = [];
  const client = new GrokClient({
    grokBaseUrl: "https://grok.com",
    defaultModel: "grok-4-auto"
  });

  client.browser = {
    async request(request) {
      requests.push(request);
      return {
        meta: {
          status: 200
        },
        text: JSON.stringify({
          fileMetadataId: "file-meta-123"
        })
      };
    }
  };

  return {
    client,
    requests
  };
}

test("uploadFile base64-encodes normalized buffers without wrapping them in Buffer.from again", async () => {
  const { client, requests } = createClient();
  const originalBufferFrom = Buffer.from;
  let wrappedBufferCount = 0;

  Buffer.from = function patchedBufferFrom(value, ...rest) {
    if (Buffer.isBuffer(value)) {
      wrappedBufferCount += 1;
    }

    return Reflect.apply(originalBufferFrom, this, [value, ...rest]);
  };

  try {
    await client.uploadFile({
      filename: "photo.bin",
      mimeType: "application/octet-stream",
      bytes: new Uint8Array([1, 2, 3, 4])
    });
  } finally {
    Buffer.from = originalBufferFrom;
  }

  assert.equal(wrappedBufferCount, 0);
  assert.equal(requests.length, 1);
  assert.equal(
    Buffer.from(requests[0].body.content, "base64").toString("hex"),
    "01020304"
  );
});
