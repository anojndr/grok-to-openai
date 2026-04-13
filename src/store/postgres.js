import fs from "node:fs/promises";
import { Pool } from "pg";
import { sanitizeFilename } from "../lib/fs.js";
import { createId, unixTimestampSeconds } from "../lib/ids.js";
import { materializeResponseRecord } from "./history.js";

const FILES_TABLE = "bridge_files";
const RESPONSES_TABLE = "bridge_responses";
const FILE_APPEND_CHUNK_SIZE = 1024 * 1024;

function assertPostgresUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  const protocol = url.protocol.toLowerCase();

  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error(
      "DATABASE_URL must use the postgres:// or postgresql:// scheme"
    );
  }

  return url;
}

export function buildPostgresPoolOptions(databaseUrl) {
  const url = assertPostgresUrl(databaseUrl);
  const sslmode = url.searchParams.get("sslmode")?.toLowerCase();
  const options = {
    connectionString: databaseUrl
  };

  if (!sslmode) {
    return options;
  }

  if (sslmode === "disable") {
    options.ssl = false;
    return options;
  }

  options.ssl =
    sslmode === "verify-full"
      ? { rejectUnauthorized: true }
      : { rejectUnauthorized: false };

  return options;
}

export class PostgresFileStore {
  constructor(pool) {
    this.pool = pool;
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${FILES_TABLE} (
        id TEXT PRIMARY KEY,
        record JSONB NOT NULL,
        content BYTEA NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async create({
    filename,
    bytes,
    purpose = "user_data",
    mimeType = "application/octet-stream"
  }) {
    const id = createId("file");
    const safeName = sanitizeFilename(filename || "upload.bin");
    const createdAt = unixTimestampSeconds();
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const record = {
      id,
      object: "file",
      bytes: content.length,
      created_at: createdAt,
      filename: safeName,
      purpose,
      mime_type: mimeType,
      status: "processed"
    };

    await this.pool.query(
      `
        INSERT INTO ${FILES_TABLE} (id, record, content)
        VALUES ($1, $2::jsonb, $3)
        ON CONFLICT (id) DO UPDATE
        SET record = EXCLUDED.record,
            content = EXCLUDED.content,
            updated_at = NOW()
      `,
      [id, JSON.stringify(record), content]
    );

    return this.toOpenAIFile(record);
  }

  async createFromPath({
    filename,
    sourcePath,
    purpose = "user_data",
    mimeType = "application/octet-stream",
    size
  }) {
    const id = createId("file");
    const safeName = sanitizeFilename(filename || "upload.bin");
    const createdAt = unixTimestampSeconds();
    const contentBytes =
      Number.isFinite(size) && size >= 0 ? size : (await fs.stat(sourcePath)).size;
    const record = {
      id,
      object: "file",
      bytes: contentBytes,
      created_at: createdAt,
      filename: safeName,
      purpose,
      mime_type: mimeType,
      status: "processed"
    };
    const queryable = await this.getQueryable();
    const canRelease = typeof queryable.release === "function";

    try {
      if (canRelease) {
        await queryable.query("BEGIN");
      }

      await queryable.query(
        `
          INSERT INTO ${FILES_TABLE} (id, record, content)
          VALUES ($1, $2::jsonb, $3)
          ON CONFLICT (id) DO UPDATE
          SET record = EXCLUDED.record,
              content = EXCLUDED.content,
              updated_at = NOW()
        `,
        [id, JSON.stringify(record), Buffer.alloc(0)]
      );

      await this.appendFileContent(queryable, id, sourcePath);

      if (canRelease) {
        await queryable.query("COMMIT");
      }
    } catch (error) {
      if (canRelease) {
        await queryable.query("ROLLBACK").catch(() => {});
      }
      throw error;
    } finally {
      if (canRelease) {
        queryable.release();
      }
    }

    return this.toOpenAIFile(record);
  }

  async get(id) {
    const record = await this.getRecord(id);
    return record ? this.toOpenAIFile(record) : null;
  }

  async getContent(id) {
    const result = await this.pool.query(
      `SELECT content FROM ${FILES_TABLE} WHERE id = $1`,
      [id]
    );

    return result.rows[0]?.content ?? null;
  }

  async getWithContent(id) {
    const result = await this.pool.query(
      `SELECT record, content FROM ${FILES_TABLE} WHERE id = $1`,
      [id]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      record: row.record,
      content: row.content
    };
  }

  async getRecord(id) {
    const result = await this.pool.query(
      `SELECT record FROM ${FILES_TABLE} WHERE id = $1`,
      [id]
    );

    return result.rows[0]?.record ?? null;
  }

  async getQueryable() {
    if (typeof this.pool.connect === "function") {
      return this.pool.connect();
    }

    return this.pool;
  }

  async appendFileContent(queryable, id, sourcePath) {
    const handle = await fs.open(sourcePath, "r");
    const chunk = Buffer.allocUnsafe(FILE_APPEND_CHUNK_SIZE);

    try {
      while (true) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) {
          break;
        }

        await queryable.query(
          `
            UPDATE ${FILES_TABLE}
            SET content = content || $2,
                updated_at = NOW()
            WHERE id = $1
          `,
          [id, chunk.subarray(0, bytesRead)]
        );
      }
    } finally {
      await handle.close();
    }
  }

  toOpenAIFile(record) {
    return {
      id: record.id,
      object: "file",
      bytes: record.bytes,
      created_at: record.created_at,
      filename: record.filename,
      purpose: record.purpose,
      status: record.status
    };
  }
}

export class PostgresResponseStore {
  constructor(pool) {
    this.pool = pool;
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${RESPONSES_TABLE} (
        id TEXT PRIMARY KEY,
        record JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async set(record) {
    await this.pool.query(
      `
        INSERT INTO ${RESPONSES_TABLE} (id, record)
        VALUES ($1, $2::jsonb)
        ON CONFLICT (id) DO UPDATE
        SET record = EXCLUDED.record,
            updated_at = NOW()
      `,
      [record.id, JSON.stringify(record)]
    );

    return record;
  }

  async get(id) {
    const result = await this.pool.query(
      `SELECT record FROM ${RESPONSES_TABLE} WHERE id = $1`,
      [id]
    );

    return result.rows[0]?.record ?? null;
  }

  async getWithHistory(id) {
    const record = await this.get(id);
    return materializeResponseRecord(record, (previousId) => this.get(previousId));
  }
}

export class PostgresStorage {
  constructor(databaseUrl, options = {}) {
    this.pool =
      options.pool ??
      new Pool(buildPostgresPoolOptions(databaseUrl));
    this.fileStore = new PostgresFileStore(this.pool);
    this.responseStore = new PostgresResponseStore(this.pool);
  }

  async init() {
    await this.fileStore.init();
    await this.responseStore.init();
  }

  async close() {
    await this.pool.end();
  }
}
