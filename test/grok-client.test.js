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

test("uploadFile normalizes UTF-16 text uploads to UTF-8 before sending them to Grok", async () => {
  const { client, requests } = createClient();

  await client.uploadFile({
    filename: "notes.txt",
    mimeType: "text/plain",
    bytes: Buffer.from([
      0xff,
      0xfe,
      0x48,
      0x00,
      0x65,
      0x00,
      0x6c,
      0x00,
      0x6c,
      0x00,
      0x6f,
      0x00
    ])
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.fileMimeType, "text/plain");
  assert.equal(
    Buffer.from(requests[0].body.content, "base64").toString("utf8"),
    "Hello"
  );
});

test("uploadFile infers CSV text uploads from the filename and sends UTF-8 bytes", async () => {
  const { client, requests } = createClient();

  await client.uploadFile({
    filename: "report.csv",
    mimeType: "application/octet-stream",
    bytes: Buffer.from([
      0xff,
      0xfe,
      0x6e,
      0x00,
      0x61,
      0x00,
      0x6d,
      0x00,
      0x65,
      0x00,
      0x2c,
      0x00,
      0x63,
      0x00,
      0x69,
      0x00,
      0x74,
      0x00,
      0x79,
      0x00,
      0x0a,
      0x00,
      0x41,
      0x00,
      0x6e,
      0x00,
      0x61,
      0x00,
      0x2c,
      0x00,
      0x4d,
      0x00,
      0xe1,
      0x00,
      0x6c,
      0x00,
      0x61,
      0x00,
      0x67,
      0x00,
      0x61,
      0x00
    ])
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.fileMimeType, "text/csv");
  assert.equal(
    Buffer.from(requests[0].body.content, "base64").toString("utf8"),
    "name,city\nAna,Málaga"
  );
});

test("createConversationAndRespond captures a delayed final response without a trailing newline", async () => {
  const client = new GrokClient({
    grokBaseUrl: "https://grok.com",
    defaultModel: "grok-4-auto"
  });

  client.browser = {
    async request(request) {
      request.onChunk?.(
        JSON.stringify({
          result: {
            response: {
              modelResponse: {
                responseId: "resp_123",
                message: "Finished after running code."
              }
            }
          }
        })
      );

      return {
        meta: {
          status: 200
        },
        text: ""
      };
    }
  };

  const result = await client.createConversationAndRespond({
    model: "grok-4-auto",
    message: "Run this snippet and summarize the result."
  });

  assert.equal(result.state.modelResponse?.message, "Finished after running code.");
  assert.equal(result.state.assistantText, "Finished after running code.");
});

test("addResponse hydrates the final assistant response when the stream closes before modelResponse arrives", async () => {
  const requests = [];
  const client = new GrokClient({
    grokBaseUrl: "https://grok.com",
    defaultModel: "grok-4-auto"
  });

  client.browser = {
    async request(request) {
      requests.push({
        url: request.url,
        method: request.method,
        body: request.body
      });

      if (request.url.endsWith("/responses")) {
        request.onChunk?.(
          `${JSON.stringify({
            result: {
              userResponse: {
                responseId: "user_123"
              }
            }
          })}\n`
        );
        request.onChunk?.(
          `${JSON.stringify({
            result: {
              token: "Thinking about your request",
              isThinking: true
            }
          })}\n`
        );

        return {
          meta: {
            status: 200
          },
          text: ""
        };
      }

      if (request.url.endsWith("/response-node?includeThreads=true")) {
        return {
          meta: {
            status: 200
          },
          text: JSON.stringify({
            responseNodes: [
              {
                responseId: "assistant_123",
                sender: "ASSISTANT",
                parentResponseId: "user_123"
              }
            ]
          })
        };
      }

      if (request.url.endsWith("/load-responses")) {
        return {
          meta: {
            status: 200
          },
          text: JSON.stringify({
            responses: [
              {
                responseId: "assistant_123",
                sender: "ASSISTANT",
                message: "Recovered final answer."
              }
            ]
          })
        };
      }

      throw new Error(`Unexpected request URL: ${request.url}`);
    }
  };

  const result = await client.addResponse({
    conversationId: "conv_123",
    parentResponseId: "parent_123",
    model: "grok-4-auto",
    message: "Follow up"
  });

  assert.equal(result.state.userResponse?.responseId, "user_123");
  assert.equal(result.state.modelResponse?.responseId, "assistant_123");
  assert.equal(result.state.modelResponse?.message, "Recovered final answer.");
  assert.equal(requests.length, 3);
});

test("createConversationAndRespond forwards heavy mode IDs to Grok", async () => {
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
        text: ""
      };
    }
  };

  await client.createConversationAndRespond({
    model: "grok-4-heavy",
    message: "Think harder."
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.modeId, "heavy");
});

test("conversation requests reuse the same deviceEnvInfo object", async () => {
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
        text: ""
      };
    }
  };

  await client.createConversationAndRespond({
    model: "grok-4-auto",
    message: "First"
  });
  await client.addResponse({
    conversationId: "conv_123",
    parentResponseId: "resp_123",
    model: "grok-4-auto",
    message: "Second"
  });

  assert.equal(requests.length, 2);
  assert.strictEqual(
    requests[0].body.deviceEnvInfo,
    requests[1].body.deviceEnvInfo
  );
});
