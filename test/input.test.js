import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeChatCompletionInput,
  normalizeConversationInput,
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
