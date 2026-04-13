import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildPostgresPoolOptions,
  PostgresFileStore,
  PostgresResponseStore,
  PostgresStorage
} from "../src/store/postgres.js";

class FakePool {
  constructor() {
    this.files = new Map();
    this.responses = new Map();
    this.queries = [];
    this.closed = false;
  }

  async query(text, params = []) {
    const sql = text.replace(/\s+/g, " ").trim();
    this.queries.push({ sql, params });

    if (sql.startsWith("CREATE TABLE IF NOT EXISTS bridge_files")) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.startsWith("CREATE TABLE IF NOT EXISTS bridge_responses")) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.startsWith("INSERT INTO bridge_files")) {
      const [id, record, content] = params;
      this.files.set(id, {
        record: JSON.parse(record),
        content: Buffer.from(content)
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE bridge_files SET content = content || $2")) {
      const [id, content] = params;
      const row = this.files.get(id);

      if (!row) {
        return { rows: [], rowCount: 0 };
      }

      row.content = Buffer.concat([row.content, Buffer.from(content)]);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("SELECT content FROM bridge_files")) {
      const row = this.files.get(params[0]);
      return {
        rows: row
          ? [
              {
                content: row.content
              }
            ]
          : [],
        rowCount: row ? 1 : 0
      };
    }

    if (sql.startsWith("SELECT record, content FROM bridge_files")) {
      const row = this.files.get(params[0]);
      return {
        rows: row
          ? [
              {
                record: row.record,
                content: row.content
              }
            ]
          : [],
        rowCount: row ? 1 : 0
      };
    }

    if (sql.startsWith("SELECT record FROM bridge_files")) {
      const row = this.files.get(params[0]);
      return {
        rows: row
          ? [
              {
                record: row.record
              }
            ]
          : [],
        rowCount: row ? 1 : 0
      };
    }

    if (sql.startsWith("INSERT INTO bridge_responses")) {
      const [id, record] = params;
      this.responses.set(id, JSON.parse(record));
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("SELECT record FROM bridge_responses")) {
      const row = this.responses.get(params[0]);
      return {
        rows: row
          ? [
              {
                record: row
              }
            ]
          : [],
        rowCount: row ? 1 : 0
      };
    }

    throw new Error(`Unhandled query: ${sql}`);
  }

  async end() {
    this.closed = true;
  }
}

test("buildPostgresPoolOptions disables ssl when sslmode=disable", () => {
  const options = buildPostgresPoolOptions(
    "postgresql://user:pass@db.example.com:5432/app?sslmode=disable"
  );

  assert.equal(options.connectionString.includes("postgresql://"), true);
  assert.equal(options.ssl, false);
});

test("buildPostgresPoolOptions leaves ssl unset when sslmode is omitted", () => {
  const options = buildPostgresPoolOptions(
    "postgresql://user:pass@db.example.com:5432/app"
  );

  assert.equal("ssl" in options, false);
});

test("buildPostgresPoolOptions enables strict ssl when sslmode=verify-full", () => {
  const options = buildPostgresPoolOptions(
    "postgres://user:pass@db.example.com:5432/app?sslmode=verify-full"
  );

  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
});

test("buildPostgresPoolOptions rejects non-postgres schemes", () => {
  assert.throws(
    () => buildPostgresPoolOptions("mysql://user:pass@localhost/app"),
    /DATABASE_URL must use/
  );
});

test("PostgresFileStore stores metadata and bytes", async () => {
  const pool = new FakePool();
  const store = new PostgresFileStore(pool);
  await store.init();

  const created = await store.create({
    filename: "bad file?.txt",
    bytes: Buffer.from("hello"),
    purpose: "user_data",
    mimeType: "text/plain"
  });

  assert.match(created.id, /^file_/);
  assert.equal(created.filename, "bad_file_.txt");
  assert.equal(created.bytes, 5);

  const record = await store.getRecord(created.id);
  assert.equal(record?.mime_type, "text/plain");

  const content = await store.getContent(created.id);
  assert.equal(content?.toString("utf8"), "hello");

  const openaiFile = await store.get(created.id);
  assert.deepEqual(openaiFile, created);
});

test("PostgresFileStore fetches metadata and bytes together in one query", async () => {
  const pool = new FakePool();
  const store = new PostgresFileStore(pool);
  await store.init();

  const created = await store.create({
    filename: "bad file?.txt",
    bytes: Buffer.from("hello"),
    mimeType: "text/plain"
  });

  const queriesBeforeRead = pool.queries.length;
  const stored = await store.getWithContent(created.id);
  const readQueries = pool.queries.slice(queriesBeforeRead);

  assert.equal(stored?.record.filename, "bad_file_.txt");
  assert.equal(stored?.record.mime_type, "text/plain");
  assert.equal(stored?.content.toString("utf8"), "hello");
  assert.deepEqual(
    readQueries.map((query) => query.sql),
    ["SELECT record, content FROM bridge_files WHERE id = $1"]
  );
});

test("PostgresFileStore can create a record from a temp upload path", async () => {
  const pool = new FakePool();
  const store = new PostgresFileStore(pool);
  await store.init();

  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "grok-to-openai-postgres-store-")
  );
  const uploadPath = path.join(tempDir, "upload.txt");
  await fs.writeFile(uploadPath, "hello from disk");

  try {
    const created = await store.createFromPath({
      filename: "upload.txt",
      sourcePath: uploadPath,
      mimeType: "text/plain"
    });

    assert.match(created.id, /^file_/);
    assert.equal(created.bytes, 15);
    assert.equal(created.filename, "upload.txt");

    const content = await store.getContent(created.id);
    assert.equal(content?.toString("utf8"), "hello from disk");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("PostgresFileStore creates records from temp upload paths without calling fs.readFile", async () => {
  const pool = new FakePool();
  const store = new PostgresFileStore(pool);
  await store.init();

  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "grok-to-openai-postgres-store-")
  );
  const uploadPath = path.join(tempDir, "upload.txt");
  const originalReadFile = fs.readFile;
  await fs.writeFile(uploadPath, "stream me");

  fs.readFile = async () => {
    throw new Error("createFromPath should not use fs.readFile");
  };

  try {
    const created = await store.createFromPath({
      filename: "upload.txt",
      sourcePath: uploadPath,
      mimeType: "text/plain",
      size: 9
    });

    assert.match(created.id, /^file_/);
    assert.equal(created.bytes, 9);

    const content = await store.getContent(created.id);
    assert.equal(content?.toString("utf8"), "stream me");
  } finally {
    fs.readFile = originalReadFile;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("PostgresResponseStore stores full response records", async () => {
  const pool = new FakePool();
  const store = new PostgresResponseStore(pool);
  await store.init();

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

  await store.set(record);

  assert.deepEqual(await store.get("resp_123"), record);
  assert.equal(await store.get("resp_missing"), null);
});

test("PostgresResponseStore reconstructs compact history chains on demand", async () => {
  const pool = new FakePool();
  const store = new PostgresResponseStore(pool);
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

test("PostgresStorage initializes both stores and closes the pool", async () => {
  const pool = new FakePool();
  const storage = new PostgresStorage(
    "postgresql://user:pass@db.example.com:5432/app?sslmode=disable",
    { pool }
  );

  await storage.init();
  await storage.close();

  assert.equal(pool.closed, true);
  assert.equal(
    pool.queries.some(({ sql }) =>
      sql.startsWith("CREATE TABLE IF NOT EXISTS bridge_files")
    ),
    true
  );
  assert.equal(
    pool.queries.some(({ sql }) =>
      sql.startsWith("CREATE TABLE IF NOT EXISTS bridge_responses")
    ),
    true
  );
});
