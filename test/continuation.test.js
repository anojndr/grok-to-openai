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
    async getRecord(id) {
      return records.get(id)?.record ?? null;
    },
    async getContent(id) {
      return records.get(id)?.bytes ?? null;
    }
  };
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

test("buildConversationHistory stores only the current turn delta", async () => {
  const fileStore = createMemoryFileStore();
  const existingFile = await fileStore.create({
    filename: "note.txt",
    bytes: Buffer.from("alpha"),
    mimeType: "text/plain"
  });

  const history = await buildConversationHistory({
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
          mimeType: "image/png",
          title: "draft-preview",
          url: "https://assets.grok.com/generated/draft-preview.png"
        }
      ]
    },
    fileStore,
    loadAssistantImageAsset: async (image) => {
      assert.equal(
        image.url,
        "https://assets.grok.com/generated/draft-preview.png"
      );
      return {
        bytes: Buffer.from("preview-image"),
        contentType: "image/png"
      };
    }
  });

  assert.equal(history.version, 2);
  assert.deepEqual(history.instructions, ["Prefer short bullet points."]);
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[0].role, "user");
  assert.equal(history.messages[1].role, "assistant");
  assert.equal(history.messages[0].attachments.length, 1);
  assert.equal(history.messages[1].attachments.length, 1);
});

test("buildConversationHistory persists input attachments in parallel while preserving message order", async () => {
  const createDeferredByFilename = new Map([
    ["first file.txt", createDeferred()],
    ["second file.txt", createDeferred()]
  ]);
  const createCalls = [];

  const historyPromise = buildConversationHistory({
    instructions: "",
    inputMessages: [
      {
        role: "user",
        text: "First attachment.",
        files: [
          {
            filename: "first file.txt",
            mimeType: "text/plain",
            bytes: Buffer.from("first")
          }
        ]
      },
      {
        role: "user",
        text: "Second attachment.",
        files: [
          {
            filename: "second file.txt",
            mimeType: "text/plain",
            bytes: Buffer.from("second")
          }
        ]
      }
    ],
    assistantOutput: null,
    fileStore: {
      async create({ filename }) {
        createCalls.push(filename);
        return createDeferredByFilename.get(filename).promise;
      },
      async getRecord() {
        throw new Error("getRecord should not be called after create");
      }
    }
  });

  await flushAsyncOperations();
  assert.deepEqual(createCalls, ["first file.txt", "second file.txt"]);

  createDeferredByFilename.get("second file.txt").resolve({
    id: "stored:second file.txt",
    filename: "second_file.txt"
  });
  createDeferredByFilename.get("first file.txt").resolve({
    id: "stored:first file.txt",
    filename: "first_file.txt"
  });

  const history = await historyPromise;
  assert.deepEqual(
    history.messages.map((message) => message.text),
    ["First attachment.", "Second attachment."]
  );
  assert.deepEqual(
    history.messages.map((message) => message.attachments[0].filename),
    ["first_file.txt", "second_file.txt"]
  );
});

test("buildConversationHistory persists assistant images in parallel while preserving order", async () => {
  const assetDeferredByTitle = new Map([
    ["first-preview", createDeferred()],
    ["second-preview", createDeferred()]
  ]);
  const loadCalls = [];

  const historyPromise = buildConversationHistory({
    instructions: "",
    inputMessages: [],
    assistantOutput: {
      text: "",
      images: [
        {
          title: "first-preview",
          mimeType: "image/png",
          url: "https://assets.grok.com/generated/first-preview.png"
        },
        {
          title: "second-preview",
          mimeType: "image/png",
          url: "https://assets.grok.com/generated/second-preview.png"
        }
      ]
    },
    fileStore: {
      async create({ filename }) {
        return {
          id: `stored:${filename}`,
          filename: filename.replace(/-/g, "_")
        };
      },
      async getRecord() {
        throw new Error("getRecord should not be called after create");
      }
    },
    loadAssistantImageAsset: async (image) => {
      loadCalls.push(image.title);
      return assetDeferredByTitle.get(image.title).promise;
    }
  });

  await flushAsyncOperations();
  assert.deepEqual(loadCalls, ["first-preview", "second-preview"]);

  assetDeferredByTitle.get("second-preview").resolve({
    bytes: Buffer.from("second-image"),
    contentType: "image/png"
  });
  assetDeferredByTitle.get("first-preview").resolve({
    bytes: Buffer.from("first-image"),
    contentType: "image/png"
  });

  const history = await historyPromise;
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].role, "assistant");
  assert.deepEqual(
    history.messages[0].attachments.map((attachment) => attachment.filename),
    ["first_preview.png", "second_preview.png"]
  );
});

test("buildConversationHistory persists assistant image bytes without refetching", async () => {
  let loadCalls = 0;

  const history = await buildConversationHistory({
    instructions: "",
    inputMessages: [],
    assistantOutput: {
      text: "",
      images: [
        {
          title: "hosted-preview",
          mimeType: "image/png",
          url: "https://i.ibb.co/demo/hosted-preview.png",
          bytes: Buffer.from("hosted-image")
        }
      ]
    },
    fileStore: {
      async create({ filename, bytes, mimeType }) {
        assert.equal(filename, "hosted-preview.png");
        assert.equal(bytes.toString("utf8"), "hosted-image");
        assert.equal(mimeType, "image/png");
        return {
          id: "stored:hosted-preview",
          filename
        };
      },
      async getRecord() {
        throw new Error("getRecord should not be called after create");
      }
    },
    loadAssistantImageAsset: async () => {
      loadCalls += 1;
      return null;
    }
  });

  assert.equal(loadCalls, 0);
  assert.equal(history.messages.length, 1);
  assert.deepEqual(history.messages[0].attachments, [
    {
      fileId: "stored:hosted-preview",
      filename: "hosted-preview.png",
      mimeType: "image/png"
    }
  ]);
});

test("buildReplayConversationRequest includes the full stored history and all attachments", async () => {
  const fileStore = createMemoryFileStore();
  const noteFile = await fileStore.create({
    filename: "note.txt",
    bytes: Buffer.from("alpha"),
    mimeType: "text/plain"
  });
  const previewFile = await fileStore.create({
    filename: "draft-preview.png",
    bytes: Buffer.from("preview-image"),
    mimeType: "image/png"
  });

  const previousHistory = {
    instructions: ["Be exact.", "Prefer short bullet points."],
    messages: [
      {
        role: "assistant",
        text: "Earlier summary.",
        attachments: []
      },
      {
        role: "user",
        text: "Compare this note to the draft.",
        attachments: [
          {
            fileId: noteFile.id,
            filename: "note.txt",
            mimeType: "text/plain"
          }
        ]
      },
      {
        role: "assistant",
        text: "The draft is more detailed.",
        attachments: [
          {
            fileId: previewFile.id,
            filename: "draft-preview.png",
            mimeType: "image/png"
          }
        ]
      }
    ]
  };

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

test("buildReplayConversationRequest hydrates stored attachments in parallel while preserving order", async () => {
  const attachmentDeferredById = new Map([
    ["file_1", createDeferred()],
    ["file_2", createDeferred()]
  ]);
  const getContentCalls = [];

  const replayPromise = buildReplayConversationRequest({
    previousHistory: {
      instructions: [],
      messages: [
        {
          role: "user",
          text: "Compare the stored files.",
          attachments: [
            {
              fileId: "file_1",
              filename: "one.txt",
              mimeType: "text/plain"
            },
            {
              fileId: "file_2",
              filename: "two.txt",
              mimeType: "text/plain"
            }
          ]
        }
      ]
    },
    currentMessages: [],
    fileStore: {
      async getContent(id) {
        getContentCalls.push(id);
        return attachmentDeferredById.get(id).promise;
      }
    }
  });

  await flushAsyncOperations();
  assert.deepEqual(getContentCalls, ["file_1", "file_2"]);

  attachmentDeferredById.get("file_2").resolve(Buffer.from("second"));
  attachmentDeferredById.get("file_1").resolve(Buffer.from("first"));

  const replay = await replayPromise;
  assert.deepEqual(
    replay.files.map((file) => file.filename),
    [
      "turn-001-user-attachment-001-one.txt",
      "turn-001-user-attachment-002-two.txt"
    ]
  );
  assert.deepEqual(
    replay.files.map((file) => file.bytes.toString("utf8")),
    ["first", "second"]
  );
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
      },
      {
        role: "user",
        text: "Keep the same file in mind for the next answer.",
        attachments: []
      },
      {
        role: "assistant",
        text: "I will keep it in mind.",
        attachments: []
      }
    ]
  };
  let historyLoadCalls = 0;

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
      history: {
        version: 2,
        instructions: [],
        messages: previousHistory.messages.slice(-2)
      }
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
    fileStore,
    loadPreviousHistory: async () => {
      historyLoadCalls += 1;
      return previousHistory;
    }
  });

  assert.equal(addResponseArgs.conversationId, "conversation_old");
  assert.equal(addResponseArgs.parentResponseId, "response_old");
  assert.equal(historyLoadCalls, 1);
  assert.equal(uploadCalls.length, 2);
  assert.deepEqual(uploadCalls[0], ["follow-up.png"]);
  assert.deepEqual(uploadCalls[1], [
    "turn-001-user-attachment-001-context.txt",
    "turn-005-user-attachment-001-follow-up.png"
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
  assert.match(createConversationArgs.message, /Turn 4 \| Assistant/);
  assert.match(createConversationArgs.message, /Turn 5 \| User/);
  assert.deepEqual(result, {
    accountIndex: 0,
    model: "grok-4-auto",
    state: {
      responses: []
    }
  });
});

test("continueResponseConversation does not hydrate prior history unless replay is needed", async () => {
  const fileStore = createMemoryFileStore();
  let historyLoadCalls = 0;
  let addResponseArgs = null;

  const grokClient = {
    async addResponse(args) {
      addResponseArgs = args;
      return {
        model: args.model,
        state: {
          responses: []
        }
      };
    }
  };
  const uploadFilesToGrok = async (files) =>
    files.map((_file, index) => `upload_${index + 1}`);

  const result = await continueResponseConversation({
    previousRecord: {
      grok: {
        conversationId: "conversation_old",
        assistantResponseId: "response_old"
      },
      history: {
        version: 2,
        instructions: [],
        messages: [
          {
            role: "user",
            text: "Most recent prior message.",
            attachments: []
          },
          {
            role: "assistant",
            text: "Most recent prior answer.",
            attachments: []
          }
        ]
      }
    },
    currentMessages: [
      {
        role: "user",
        text: "Continue without replaying anything.",
        files: []
      }
    ],
    instructions: "Answer only the latest user message.",
    publicModel: "grok-4-auto",
    grokClient,
    uploadFilesToGrok,
    fileStore,
    loadPreviousHistory: async () => {
      historyLoadCalls += 1;
      throw new Error("history should not be loaded");
    }
  });

  assert.equal(addResponseArgs.conversationId, "conversation_old");
  assert.equal(addResponseArgs.parentResponseId, "response_old");
  assert.equal(historyLoadCalls, 0);
  assert.deepEqual(result, {
    accountIndex: 0,
    model: "grok-4-auto",
    state: {
      responses: []
    }
  });
});

test("continueResponseConversation replays full history for xAI stream missing-conversation errors", async () => {
  const fileStore = createMemoryFileStore();
  const priorTextFile = await fileStore.create({
    filename: "context.txt",
    bytes: Buffer.from("context"),
    mimeType: "text/plain"
  });
  const priorImageFile = await fileStore.create({
    filename: "sketch.png",
    bytes: Buffer.from("sketch"),
    mimeType: "image/png"
  });
  const previousHistory = {
    instructions: ["Keep the attachment context intact."],
    messages: [
      {
        role: "user",
        text: "Review the uploaded context.",
        attachments: [
          {
            fileId: priorTextFile.id,
            filename: "context.txt",
            mimeType: "text/plain"
          }
        ]
      },
      {
        role: "assistant",
        text: "I reviewed the text and image.",
        attachments: [
          {
            fileId: priorImageFile.id,
            filename: "sketch.png",
            mimeType: "image/png"
          }
        ]
      }
    ]
  };

  let createConversationArgs = null;
  const uploadCalls = [];
  const grokClient = {
    async addResponse() {
      throw new HttpError(
        502,
        "stream response: consume xAI responses stream: 'Conversation' with ID '355efd4f-4649-409e-9d98-22230329cbb0' was not found. type=server_error: invalid argument"
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
        text: "Use all prior context and both new attachments.",
        files: [
          {
            filename: "follow-up.pdf",
            mimeType: "application/pdf",
            bytes: Buffer.from("pdf")
          },
          {
            filename: "reference.jpg",
            mimeType: "image/jpeg",
            bytes: Buffer.from("image")
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

  assert.deepEqual(uploadCalls[0], ["follow-up.pdf", "reference.jpg"]);
  assert.deepEqual(uploadCalls[1], [
    "turn-001-user-attachment-001-context.txt",
    "turn-002-assistant-attachment-001-sketch.png",
    "turn-003-user-attachment-001-follow-up.pdf",
    "turn-003-user-attachment-002-reference.jpg"
  ]);
  assert.deepEqual(createConversationArgs.fileAttachments, [
    "upload_2_1",
    "upload_2_2",
    "upload_2_3",
    "upload_2_4"
  ]);
  assert.match(
    createConversationArgs.message,
    /The original Grok conversation could not be found in the active account/
  );
  assert.match(
    createConversationArgs.message,
    /turn-002-assistant-attachment-001-sketch.png/
  );
  assert.match(
    createConversationArgs.message,
    /turn-003-user-attachment-002-reference.jpg/
  );
  assert.deepEqual(result, {
    accountIndex: 0,
    model: "grok-4-auto",
    state: {
      responses: []
    }
  });
});

test("continueResponseConversation replays full history on follow-up errors so another account can take over", async () => {
  const fileStore = createMemoryFileStore();
  const priorFile = await fileStore.create({
    filename: "context.txt",
    bytes: Buffer.from("context"),
    mimeType: "text/plain"
  });
  const previousHistory = {
    instructions: ["Reuse the full context when recovering."],
    messages: [
      {
        role: "user",
        text: "Read the context first.",
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
        text: "I have it.",
        attachments: []
      }
    ]
  };

  const uploadCalls = [];
  const grokAccounts = {
    async withAccount(accountIndex, operation) {
      const client = {
        async addResponse() {
          throw new HttpError(429, "Grok request failed: rate limited");
        }
      };
      return {
        accountIndex,
        value: await operation(client, accountIndex)
      };
    },
    async withFallback(operation) {
      const accountIndex = 1;
      const client = {
        async createConversationAndRespond(args) {
          return {
            model: args.model,
            state: {
              responses: []
            }
          };
        }
      };
      return {
        accountIndex,
        value: await operation(client, accountIndex)
      };
    }
  };
  const uploadFilesToGrok = async (accountClient, files) => {
    uploadCalls.push(files.map((file) => file.filename));
    return files.map((_file, index) => `upload_${uploadCalls.length}_${index + 1}`);
  };

  const result = await continueResponseConversation({
    previousRecord: {
      grok: {
        accountIndex: 0,
        conversationId: "conversation_old",
        assistantResponseId: "response_old"
      },
      history: previousHistory
    },
    currentMessages: [
      {
        role: "user",
        text: "Answer using the same context on another account if needed.",
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
    grokAccounts,
    uploadFilesToGrok,
    fileStore
  });

  assert.deepEqual(uploadCalls[0], ["follow-up.png"]);
  assert.deepEqual(uploadCalls[1], [
    "turn-001-user-attachment-001-context.txt",
    "turn-003-user-attachment-001-follow-up.png"
  ]);
  assert.deepEqual(result, {
    accountIndex: 1,
    model: "grok-4-auto",
    state: {
      responses: []
    }
  });
});

test("continueResponseConversation tries grok fast on the same replay account before rotating accounts", async () => {
  const fileStore = createMemoryFileStore();
  const priorFile = await fileStore.create({
    filename: "context.txt",
    bytes: Buffer.from("context"),
    mimeType: "text/plain"
  });
  const previousHistory = {
    instructions: ["Keep the conversation intact."],
    messages: [
      {
        role: "user",
        text: "Read the context first.",
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
        text: "I have it.",
        attachments: []
      }
    ]
  };

  const replayModels = [];
  const uploadCalls = [];
  let fallbackCallCount = 0;
  const grokAccounts = {
    async withAccount(accountIndex, operation) {
      const client = {
        async addResponse() {
          throw new HttpError(429, "Grok request failed: rate limited");
        }
      };
      return {
        accountIndex,
        value: await operation(client, accountIndex)
      };
    },
    async withFallback(operation) {
      const accountIndex = fallbackCallCount;
      fallbackCallCount += 1;
      const client = {
        async createConversationAndRespond(args) {
          replayModels.push(args.model);

          if (args.model === "grok-4-auto") {
            throw new HttpError(503, "Grok request failed: upstream overloaded");
          }

          return {
            model: args.model,
            state: {
              responses: []
            }
          };
        }
      };

      return {
        accountIndex,
        value: await operation(client, accountIndex)
      };
    }
  };
  const uploadFilesToGrok = async (_accountClient, files) => {
    uploadCalls.push(files.map((file) => file.filename));
    return files.map((_file, index) => `upload_${uploadCalls.length}_${index + 1}`);
  };

  const result = await continueResponseConversation({
    previousRecord: {
      grok: {
        accountIndex: 0,
        conversationId: "conversation_old",
        assistantResponseId: "response_old"
      },
      history: previousHistory
    },
    currentMessages: [
      {
        role: "user",
        text: "Answer with the same context after recovering.",
        files: []
      }
    ],
    instructions: "Answer only the latest user message.",
    publicModel: "grok-4-auto",
    grokAccounts,
    uploadFilesToGrok,
    fileStore
  });

  assert.deepEqual(replayModels, ["grok-4-auto", "grok-4-fast"]);
  assert.equal(fallbackCallCount, 1);
  assert.equal(uploadCalls.length, 2);
  assert.deepEqual(uploadCalls[1], ["turn-001-user-attachment-001-context.txt"]);
  assert.deepEqual(result, {
    accountIndex: 0,
    model: "grok-4-fast",
    state: {
      responses: []
    }
  });
});

test("continueResponseConversation tries grok fast on the same replay account for grok heavy", async () => {
  const fileStore = createMemoryFileStore();
  const priorFile = await fileStore.create({
    filename: "context.txt",
    bytes: Buffer.from("context"),
    mimeType: "text/plain"
  });
  const previousHistory = {
    instructions: ["Keep the conversation intact."],
    messages: [
      {
        role: "user",
        text: "Read the context first.",
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
        text: "I have it.",
        attachments: []
      }
    ]
  };

  const replayModels = [];
  const uploadCalls = [];
  let fallbackCallCount = 0;
  const grokAccounts = {
    async withAccount(accountIndex, operation) {
      const client = {
        async addResponse() {
          throw new HttpError(429, "Grok request failed: rate limited");
        }
      };
      return {
        accountIndex,
        value: await operation(client, accountIndex)
      };
    },
    async withFallback(operation) {
      const accountIndex = fallbackCallCount;
      fallbackCallCount += 1;
      const client = {
        async createConversationAndRespond(args) {
          replayModels.push(args.model);

          if (args.model === "grok-4-heavy") {
            throw new HttpError(503, "Grok request failed: upstream overloaded");
          }

          return {
            model: args.model,
            state: {
              responses: []
            }
          };
        }
      };

      return {
        accountIndex,
        value: await operation(client, accountIndex)
      };
    }
  };
  const uploadFilesToGrok = async (_accountClient, files) => {
    uploadCalls.push(files.map((file) => file.filename));
    return files.map((_file, index) => `upload_${uploadCalls.length}_${index + 1}`);
  };

  const result = await continueResponseConversation({
    previousRecord: {
      grok: {
        accountIndex: 0,
        conversationId: "conversation_old",
        assistantResponseId: "response_old"
      },
      history: previousHistory
    },
    currentMessages: [
      {
        role: "user",
        text: "Answer with the same context after recovering.",
        files: []
      }
    ],
    instructions: "Answer only the latest user message.",
    publicModel: "grok-4-heavy",
    grokAccounts,
    uploadFilesToGrok,
    fileStore
  });

  assert.deepEqual(replayModels, ["grok-4-heavy", "grok-4-fast"]);
  assert.equal(fallbackCallCount, 1);
  assert.equal(uploadCalls.length, 2);
  assert.deepEqual(uploadCalls[1], ["turn-001-user-attachment-001-context.txt"]);
  assert.deepEqual(result, {
    accountIndex: 0,
    model: "grok-4-fast",
    state: {
      responses: []
    }
  });
});
