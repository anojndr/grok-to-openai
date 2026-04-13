import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/lib/errors.js";
import {
  normalizeChatCompletionInput,
  normalizeConversationInput,
  resolveImageParts,
  resolveFileParts,
  splitInstructionsAndMessages
} from "../src/openai/input.js";

function buildTranscriptPrompt(messages) {
  return messages
    .map((message) => {
      const role =
        message.role === "assistant"
          ? "Assistant"
          : message.role === "user"
            ? "User"
            : message.role;
      const attachmentSuffix =
        message.files.length > 0 ? `\n[Attachments: ${message.files.length}]` : "";
      return `${role}: ${message.text || ""}${attachmentSuffix}`.trim();
    })
    .join("\n\n");
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncOperations() {
  await Promise.resolve();
  await Promise.resolve();
}

test("splitInstructionsAndMessages keeps system text in instructions", () => {
  const result = splitInstructionsAndMessages(
    [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" }
    ],
    "Default instruction"
  );

  assert.equal(result.instructions, "Default instruction\n\nBe concise.");
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "user");
});

test("normalizeConversationInput converts input_image data URLs into attachments", async () => {
  const result = await normalizeConversationInput({
    requestBody: {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Describe this image." },
            {
              type: "input_image",
              image_url: "data:image/png;base64,Zm9v"
            }
          ]
        }
      ]
    },
    fileStore: {}
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, "Describe this image.");
  assert.equal(result.messages[0].files.length, 1);
  assert.equal(result.messages[0].files[0].mimeType, "image/png");
  assert.equal(result.messages[0].files[0].filename, "image.png");
  assert.equal(result.messages[0].files[0].bytes.toString(), "foo");
});

test("normalizeChatCompletionInput keeps developer text as instructions and image_url as attachment", async () => {
  const result = await normalizeChatCompletionInput({
    requestBody: {
      messages: [
        { role: "developer", content: "Look carefully." },
        {
          role: "user",
          content: [
            { type: "text", text: "What color is this?" },
            {
              type: "image_url",
              image_url: {
                url: "data:image/jpeg;base64,YmFy"
              }
            }
          ]
        }
      ]
    },
    fileStore: {}
  });

  assert.equal(result.instructions, "Look carefully.");
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, "What color is this?");
  assert.equal(result.messages[0].files.length, 1);
  assert.equal(result.messages[0].files[0].mimeType, "image/jpeg");
  assert.equal(result.messages[0].files[0].filename, "image.jpg");
  assert.equal(result.messages[0].files[0].bytes.toString(), "bar");
});

test("resolveFileParts keeps raw CSV file_data as text instead of base64-decoding it", async () => {
  const [file] = await resolveFileParts({
    content: [
      {
        type: "input_file",
        filename: "prices.csv",
        file_data: "date,close\n2026-01-02,123.45"
      }
    ],
    fileStore: {}
  });

  assert.equal(file.filename, "prices.csv");
  assert.equal(file.mimeType, "text/csv");
  assert.equal(file.bytes.toString("utf8"), "date,close\n2026-01-02,123.45");
});

test("resolveFileParts keeps short raw TXT file_data that happens to look like base64", async () => {
  const [file] = await resolveFileParts({
    content: [
      {
        type: "input_file",
        filename: "note.txt",
        file_data: "test"
      }
    ],
    fileStore: {}
  });

  assert.equal(file.filename, "note.txt");
  assert.equal(file.mimeType, "text/plain");
  assert.equal(file.bytes.toString("utf8"), "test");
});

test("resolveFileParts still decodes base64 file_data for text files", async () => {
  const [file] = await resolveFileParts({
    content: [
      {
        type: "input_file",
        filename: "note.txt",
        file_data: Buffer.from("hello", "utf8").toString("base64")
      }
    ],
    fileStore: {}
  });

  assert.equal(file.filename, "note.txt");
  assert.equal(file.mimeType, "text/plain");
  assert.equal(file.bytes.toString("utf8"), "hello");
});

test("resolveFileParts streams file_url bodies without using arrayBuffer", async () => {
  const originalFetch = globalThis.fetch;
  let arrayBufferCalled = false;

  globalThis.fetch = async () => {
    const response = new Response("streamed file", {
      headers: {
        "content-type": "text/plain",
        "content-length": "13"
      }
    });
    response.arrayBuffer = async () => {
      arrayBufferCalled = true;
      throw new Error("arrayBuffer should not be called");
    };
    return response;
  };

  try {
    const [file] = await resolveFileParts({
      content: [
        {
          type: "input_file",
          file_url: "https://example.com/report.txt"
        }
      ],
      fileStore: {}
    });

    assert.equal(file.filename, "report.txt");
    assert.equal(file.mimeType, "text/plain");
    assert.equal(file.bytes.toString("utf8"), "streamed file");
    assert.equal(arrayBufferCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveFileParts resolves multiple file_id attachments in parallel while preserving order", async () => {
  const deferredById = new Map([
    ["file_1", createDeferred()],
    ["file_2", createDeferred()]
  ]);
  const getWithContentCalls = [];

  const pending = resolveFileParts({
    content: [
      {
        type: "input_file",
        file_id: "file_1"
      },
      {
        type: "input_file",
        file_id: "file_2"
      }
    ],
    fileStore: {
      async getWithContent(id) {
        getWithContentCalls.push(id);
        return deferredById.get(id).promise;
      },
      async getRecord() {
        throw new Error("getRecord should not be called when getWithContent is available");
      },
      async getContent() {
        throw new Error("getContent should not be called when getWithContent is available");
      }
    }
  });

  await flushAsyncOperations();
  assert.deepEqual(getWithContentCalls, ["file_1", "file_2"]);

  deferredById.get("file_2").resolve({
    record: {
      filename: "file_2.txt",
      mime_type: "text/plain"
    },
    content: Buffer.from("second")
  });
  deferredById.get("file_1").resolve({
    record: {
      filename: "file_1.txt",
      mime_type: "text/plain"
    },
    content: Buffer.from("first")
  });

  const files = await pending;
  assert.deepEqual(
    files.map((file) => file.filename),
    ["file_1.txt", "file_2.txt"]
  );
  assert.deepEqual(
    files.map((file) => file.bytes.toString("utf8")),
    ["first", "second"]
  );
});

test("resolveImageParts streams image_url bodies without using arrayBuffer", async () => {
  const originalFetch = globalThis.fetch;
  let arrayBufferCalled = false;

  globalThis.fetch = async () => {
    const response = new Response("image-bytes", {
      headers: {
        "content-type": "image/png",
        "content-length": "11"
      }
    });
    response.arrayBuffer = async () => {
      arrayBufferCalled = true;
      throw new Error("arrayBuffer should not be called");
    };
    return response;
  };

  try {
    const [image] = await resolveImageParts({
      content: [
        {
          type: "input_image",
          image_url: "https://example.com/diagram.png"
        }
      ]
    });

    assert.equal(image.filename, "diagram.png");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.bytes.toString("utf8"), "image-bytes");
    assert.equal(arrayBufferCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveImageParts fetches multiple image_url attachments in parallel while preserving order", async () => {
  const originalFetch = globalThis.fetch;
  const responseByUrl = new Map([
    ["https://example.com/first.png", createDeferred()],
    ["https://example.com/second.png", createDeferred()]
  ]);
  const fetchCalls = [];

  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    return responseByUrl.get(url).promise;
  };

  try {
    const pending = resolveImageParts({
      content: [
        {
          type: "input_image",
          image_url: "https://example.com/first.png"
        },
        {
          type: "input_image",
          image_url: "https://example.com/second.png"
        }
      ]
    });

    await flushAsyncOperations();
    assert.deepEqual(fetchCalls, [
      "https://example.com/first.png",
      "https://example.com/second.png"
    ]);

    responseByUrl.get("https://example.com/second.png").resolve(
      new Response("second-image", {
        headers: {
          "content-type": "image/png",
          "content-length": "12"
        }
      })
    );
    responseByUrl.get("https://example.com/first.png").resolve(
      new Response("first-image", {
        headers: {
          "content-type": "image/png",
          "content-length": "11"
        }
      })
    );

    const images = await pending;
    assert.deepEqual(
      images.map((image) => image.filename),
      ["first.png", "second.png"]
    );
    assert.deepEqual(
      images.map((image) => image.bytes.toString("utf8")),
      ["first-image", "second-image"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizeConversationInput resolves independent attachment fetches in parallel while preserving message order", async () => {
  const originalFetch = globalThis.fetch;
  const responseByUrl = new Map([
    ["https://example.com/notes.txt", createDeferred()],
    ["https://example.com/diagram.png", createDeferred()],
    ["https://example.com/appendix.txt", createDeferred()]
  ]);
  const fetchCalls = [];

  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    return responseByUrl.get(url).promise;
  };

  try {
    const pending = normalizeConversationInput({
      requestBody: {
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Compare both attachments." },
              {
                type: "input_file",
                file_url: "https://example.com/notes.txt"
              },
              {
                type: "input_image",
                image_url: "https://example.com/diagram.png"
              }
            ]
          },
          {
            role: "user",
            content: [
              { type: "input_text", text: "Also include the appendix." },
              {
                type: "input_file",
                file_url: "https://example.com/appendix.txt"
              }
            ]
          }
        ]
      },
      fileStore: {}
    });

    await flushAsyncOperations();
    assert.deepEqual(fetchCalls, [
      "https://example.com/notes.txt",
      "https://example.com/diagram.png",
      "https://example.com/appendix.txt"
    ]);

    responseByUrl.get("https://example.com/appendix.txt").resolve(
      new Response("appendix", {
        headers: {
          "content-type": "text/plain",
          "content-length": "8"
        }
      })
    );
    responseByUrl.get("https://example.com/diagram.png").resolve(
      new Response("diagram-bytes", {
        headers: {
          "content-type": "image/png",
          "content-length": "13"
        }
      })
    );
    responseByUrl.get("https://example.com/notes.txt").resolve(
      new Response("notes", {
        headers: {
          "content-type": "text/plain",
          "content-length": "5"
        }
      })
    );

    const result = await pending;
    assert.deepEqual(
      result.messages.map((message) => message.text),
      ["Compare both attachments.", "Also include the appendix."]
    );
    assert.deepEqual(
      result.messages[0].files.map((file) => file.filename),
      ["notes.txt", "diagram.png"]
    );
    assert.deepEqual(
      result.messages[1].files.map((file) => file.filename),
      ["appendix.txt"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizeChatCompletionInput resolves independent attachment fetches in parallel while preserving message order", async () => {
  const originalFetch = globalThis.fetch;
  const responseByUrl = new Map([
    ["https://example.com/summary.txt", createDeferred()],
    ["https://example.com/reference.png", createDeferred()],
    ["https://example.com/context.txt", createDeferred()]
  ]);
  const fetchCalls = [];

  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    return responseByUrl.get(url).promise;
  };

  try {
    const pending = normalizeChatCompletionInput({
      requestBody: {
        messages: [
          { role: "developer", content: "Use every attachment." },
          {
            role: "user",
            content: [
              { type: "text", text: "Review the summary and image." },
              {
                type: "input_file",
                file_url: "https://example.com/summary.txt"
              },
              {
                type: "image_url",
                image_url: {
                  url: "https://example.com/reference.png"
                }
              }
            ]
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Then incorporate the context file." },
              {
                type: "input_file",
                file_url: "https://example.com/context.txt"
              }
            ]
          }
        ]
      },
      fileStore: {}
    });

    await flushAsyncOperations();
    assert.deepEqual(fetchCalls, [
      "https://example.com/summary.txt",
      "https://example.com/reference.png",
      "https://example.com/context.txt"
    ]);

    responseByUrl.get("https://example.com/context.txt").resolve(
      new Response("context", {
        headers: {
          "content-type": "text/plain",
          "content-length": "7"
        }
      })
    );
    responseByUrl.get("https://example.com/reference.png").resolve(
      new Response("reference-image", {
        headers: {
          "content-type": "image/png",
          "content-length": "15"
        }
      })
    );
    responseByUrl.get("https://example.com/summary.txt").resolve(
      new Response("summary", {
        headers: {
          "content-type": "text/plain",
          "content-length": "7"
        }
      })
    );

    const result = await pending;
    assert.equal(result.instructions, "Use every attachment.");
    assert.deepEqual(
      result.messages.map((message) => message.text),
      ["Review the summary and image.", "Then incorporate the context file."]
    );
    assert.deepEqual(
      result.messages[0].files.map((file) => file.filename),
      ["summary.txt", "reference.png"]
    );
    assert.deepEqual(
      result.messages[1].files.map((file) => file.filename),
      ["context.txt"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveImageParts accepts inline image data larger than xAI's 6 MiB cap", async () => {
  const largeBase64 = Buffer.alloc(7 * 1024 * 1024, 0x89).toString("base64");

  const [image] = await resolveImageParts({
    content: [
      {
        type: "input_image",
        image_url: `data:image/png;base64,${largeBase64}`
      }
    ]
  });

  assert.equal(image.filename, "image.png");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.bytes.length, 7 * 1024 * 1024);
  assert.equal(image.bytes[0], 0x89);
});

test("resolveFileParts accepts inline file_data larger than xAI's 6 MiB cap", async () => {
  const largeBase64 = Buffer.alloc(7 * 1024 * 1024, 0x61).toString("base64");

  const [file] = await resolveFileParts({
    content: [
      {
        type: "input_file",
        filename: "large.bin",
        file_data: largeBase64
      }
    ],
    fileStore: {}
  });

  assert.equal(file.filename, "large.bin");
  assert.equal(file.mimeType, "application/octet-stream");
  assert.equal(file.bytes.length, 7 * 1024 * 1024);
  assert.equal(file.bytes[0], 0x61);
});

test("resolveImageParts rejects remote image_url responses above the bridge upload cap", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response("ok", {
      headers: {
        "content-type": "image/png",
        "content-length": String(99 * 1024 * 1024)
      }
    });

  try {
    await assert.rejects(
      () =>
        resolveImageParts({
          content: [
            {
              type: "input_image",
              image_url: "https://example.com/large.png"
            }
          ]
        }),
      (error) =>
        error instanceof HttpError &&
        error.status === 400 &&
        /50 MiB/.test(error.message) &&
        /image_url/.test(error.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveFileParts rejects remote file_url responses above the bridge upload cap", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response("ok", {
      headers: {
        "content-type": "application/pdf",
        "content-length": String(99 * 1024 * 1024)
      }
    });

  try {
    await assert.rejects(
      () =>
        resolveFileParts({
          content: [
            {
              type: "input_file",
              file_url: "https://example.com/large.pdf"
            }
          ],
          fileStore: {}
        }),
      (error) =>
        error instanceof HttpError &&
        error.status === 400 &&
        /50 MiB/.test(error.message) &&
        /\/v1\/files/.test(error.message) &&
        /file_id/.test(error.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("history transcript keeps prior turns for follow-up requests", () => {
  const transcript = buildTranscriptPrompt([
    { role: "user", text: "my name is jandron", files: [] },
    { role: "assistant", text: "Your name is Jandron.", files: [] }
  ]);

  assert.equal(
    transcript,
    "User: my name is jandron\n\nAssistant: Your name is Jandron."
  );
});
