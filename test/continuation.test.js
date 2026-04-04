import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/lib/errors.js";
import {
  buildConversationHistory,
  buildReplayConversationRequest,
  continueResponseConversation
} from "../src/openai/continuation.js";

function createMemoryFileStore() {
  const records = new Map();
  let idCounter = 1;

  return {
    async create({
      filename,
      bytes,
      purpose = "user_data",
      mimeType = "application/octet-stream"
    }) {
      const id = `file_${idCounter++}`;
      const storedBytes = Buffer.from(bytes);
      const record = {
        id,
        bytes: storedBytes.length,
        filename,
        purpose,
        mime_type: mimeType,
        status: "processed",
        created_at: 0,
        path: `/virtual/${id}-${filename}`
      };

      records.set(id, {
        record,
        bytes: storedBytes
      });

      return {
        id,
        object: "file",
        bytes: storedBytes.length,
        created_at: 0,
        filename,
        purpose,
        status: "processed"
      };
    },
    getRecord(id) {
      return records.get(id)?.record ?? null;
    },
    async getContent(id) {
      return records.get(id)?.bytes ?? null;
    }
  };
}

test("buildReplayConversationRequest includes the full stored history and all attachments", async () => {
  const fileStore = createMemoryFileStore();
  const existingFile = await fileStore.create({
    filename: "note.txt",
    bytes: Buffer.from("alpha"),
    mimeType: "text/plain"
  });

  const previousHistory = await buildConversationHistory({
    previousHistory: {
      instructions: ["Be exact."],
      messages: [
        {
          role: "assistant",
          text: "Earlier summary.",
          attachments: []
        }
      ]
    },
    instructions: "Prefer short bullet points.",
    inputMessages: [
      {
        role: "user",
        text: "Compare this note to the draft.",
        files: [
          {
            fileId: existingFile.id,
            filename: "note.txt",
            mimeType: "text/plain",
            bytes: Buffer.from("alpha")
          }
        ]
      }
    ],
    assistantOutput: {
      text: "The draft is more detailed.",
      images: [
        {
          result: Buffer.from("preview-image").toString("base64"),
          mimeType: "image/png",
          title: "draft-preview",
          url: "https://assets.grok.com/generated/draft-preview.png"
        }
      ]
    },
    fileStore
  });

  const replay = await buildReplayConversationRequest({
    previousHistory,
    currentMessages: [
      {
        role: "user",
        text: "Revise the preview and explain the changes.",
        files: [
          {
            filename: "diff.png",
            mimeType: "image/png",
            bytes: Buffer.from("delta")
          }
        ]
      }
    ],
    fileStore
  });

  assert.deepEqual(previousHistory.instructions, [
    "Be exact.",
    "Prefer short bullet points."
  ]);
  assert.equal(replay.files.length, 3);
  assert.equal(replay.files[0].bytes.toString(), "alpha");
  assert.equal(replay.files[1].bytes.toString(), "preview-image");
  assert.equal(replay.files[2].bytes.toString(), "delta");
  assert.match(replay.message, /Prior instructions:/);
  assert.match(replay.message, /Turn 1 \| Assistant/);
  assert.match(replay.message, /Turn 2 \| User/);
  assert.match(replay.message, /Turn 3 \| Assistant/);
  assert.match(replay.message, /Turn 4 \| User/);
  assert.match(replay.message, /turn-002-user-attachment-001-note.txt/);
  assert.match(
    replay.message,
    /turn-003-assistant-attachment-001-draft-preview.png/
  );
  assert.match(replay.message, /turn-004-user-attachment-001-diff.png/);
});

test("continueResponseConversation falls back to replaying history when the Grok conversation is missing", async () => {
  const fileStore = createMemoryFileStore();
  const priorFile = await fileStore.create({
    filename: "context.txt",
    bytes: Buffer.from("context"),
    mimeType: "text/plain"
  });
  const previousHistory = {
    instructions: ["Stay grounded in the attachments."],
    messages: [
      {
        role: "user",
        text: "Read the context file.",
        attachments: [
          {
            fileId: priorFile.id,
            filename: "context.txt",
            mimeType: "text/plain"
          }
        ]
      },
      {
        role: "assistant",
        text: "I have read it.",
        attachments: []
      }
    ]
  };

  let addResponseArgs = null;
  let createConversationArgs = null;
  const uploadCalls = [];
  const grokClient = {
    async addResponse(args) {
      addResponseArgs = args;
      throw new HttpError(
        404,
        "Grok request failed: conversation not found in this account"
      );
    },
    async createConversationAndRespond(args) {
      createConversationArgs = args;
      return {
        model: args.model,
        state: {
          responses: []
        }
      };
    }
  };
  const uploadFilesToGrok = async (files) => {
    uploadCalls.push(files.map((file) => file.filename));
    return files.map((_file, index) => `upload_${uploadCalls.length}_${index + 1}`);
  };

  const result = await continueResponseConversation({
    previousRecord: {
      grok: {
        conversationId: "conversation_old",
        assistantResponseId: "response_old"
      },
      history: previousHistory
    },
    currentMessages: [
      {
        role: "user",
        text: "Now answer the follow-up with the same context.",
        files: [
          {
            filename: "follow-up.png",
            mimeType: "image/png",
            bytes: Buffer.from("follow-up")
          }
        ]
      }
    ],
    instructions: "Answer only the latest user message.",
    publicModel: "grok-4-auto",
    grokClient,
    uploadFilesToGrok,
    fileStore
  });

  assert.equal(addResponseArgs.conversationId, "conversation_old");
  assert.equal(addResponseArgs.parentResponseId, "response_old");
  assert.equal(uploadCalls.length, 2);
  assert.deepEqual(uploadCalls[0], ["follow-up.png"]);
  assert.deepEqual(uploadCalls[1], [
    "turn-001-user-attachment-001-context.txt",
    "turn-003-user-attachment-001-follow-up.png"
  ]);
  assert.equal(createConversationArgs.instructions, "Answer only the latest user message.");
  assert.equal(createConversationArgs.model, "grok-4-auto");
  assert.deepEqual(createConversationArgs.fileAttachments, [
    "upload_2_1",
    "upload_2_2"
  ]);
  assert.match(
    createConversationArgs.message,
    /The original Grok conversation could not be found in the active account/
  );
  assert.match(createConversationArgs.message, /Turn 2 \| Assistant/);
  assert.match(createConversationArgs.message, /Turn 3 \| User/);
  assert.deepEqual(result, {
    model: "grok-4-auto",
    state: {
      responses: []
    }
  });
});
