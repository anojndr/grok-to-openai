import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ResponseStore } from "../src/store/response-store.js";

async function createTempDataDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "response-store-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("ResponseStore persists one compact JSON file per response", async (t) => {
  const dataDir = await createTempDataDir(t);
  const store = new ResponseStore(dataDir);
  const record = {
    id: "resp_123",
    response: {
      id: "resp_123",
      object: "response"
    },
    grok: {
      conversationId: "conversation_1"
    },
    history: {
      messages: []
    }
  };

  await store.init();
  await store.set(record);

  const responsesDir = path.join(dataDir, "responses");
  const responsePath = path.join(responsesDir, "resp_123.json");
  const persisted = await fs.readFile(responsePath, "utf8");

  assert.deepEqual(await store.get("resp_123"), record);
  assert.match(persisted, /^\{"id":"resp_123"/);
  assert.equal(persisted.includes("\n  \"response\""), false);
  await assert.rejects(fs.stat(path.join(dataDir, "responses.json")), /ENOENT/);
});

test("ResponseStore can still read legacy monolithic responses.json records", async (t) => {
  const dataDir = await createTempDataDir(t);
  const legacyPath = path.join(dataDir, "responses.json");
  const migratedPath = path.join(dataDir, "responses", "resp_legacy.json");
  const legacyRecord = {
    id: "resp_legacy",
    response: {
      id: "resp_legacy",
      object: "response"
    },
    grok: {
      conversationId: "conversation_legacy"
    },
    history: {
      messages: []
    }
  };

  await fs.writeFile(
    legacyPath,
    `${JSON.stringify({ responses: { [legacyRecord.id]: legacyRecord } }, null, 2)}\n`,
    "utf8"
  );

  const store = new ResponseStore(dataDir);
  await store.init();

  assert.deepEqual(await store.get(legacyRecord.id), legacyRecord);
  assert.equal(await fs.readFile(migratedPath, "utf8"), `${JSON.stringify(legacyRecord)}\n`);
});

test("ResponseStore reconstructs compact history chains on demand", async (t) => {
  const dataDir = await createTempDataDir(t);
  const store = new ResponseStore(dataDir);
  await store.init();

  await store.set({
    id: "resp_1",
    previous_response_id: null,
    response: {
      id: "resp_1",
      object: "response",
      previous_response_id: null
    },
    grok: {
      conversationId: "conversation_1"
    },
    history: {
      version: 2,
      instructions: ["Be exact."],
      messages: [
        {
          role: "user",
          text: "First question",
          attachments: []
        },
        {
          role: "assistant",
          text: "First answer",
          attachments: []
        }
      ]
    }
  });

  await store.set({
    id: "resp_2",
    previous_response_id: "resp_1",
    response: {
      id: "resp_2",
      object: "response",
      previous_response_id: "resp_1"
    },
    grok: {
      conversationId: "conversation_1"
    },
    history: {
      version: 2,
      instructions: ["Prefer short bullet points."],
      messages: [
        {
          role: "user",
          text: "Second question",
          attachments: []
        },
        {
          role: "assistant",
          text: "Second answer",
          attachments: []
        }
      ]
    }
  });

  const raw = await store.get("resp_2");
  assert.deepEqual(raw.history.instructions, ["Prefer short bullet points."]);
  assert.equal(raw.history.messages.length, 2);

  const hydrated = await store.getWithHistory("resp_2");
  assert.deepEqual(hydrated.history.instructions, [
    "Be exact.",
    "Prefer short bullet points."
  ]);
  assert.deepEqual(
    hydrated.history.messages.map((message) => message.text),
    ["First question", "First answer", "Second question", "Second answer"]
  );
});
