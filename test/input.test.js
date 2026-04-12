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

test("resolveFileParts rejects oversized inline file_data and points callers to file uploads", async () => {
  const largeBase64 = Buffer.alloc(7 * 1024 * 1024, 0x61).toString("base64");

  await assert.rejects(
    () =>
      resolveFileParts({
        content: [
          {
            type: "input_file",
            filename: "large.bin",
            file_data: largeBase64
          }
        ],
        fileStore: {}
      }),
    (error) =>
      error instanceof HttpError &&
      error.status === 400 &&
      /\/v1\/files/.test(error.message) &&
      /file_id/.test(error.message)
  );
});

test("resolveFileParts rejects oversized remote file_url responses with file upload guidance", async () => {
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
