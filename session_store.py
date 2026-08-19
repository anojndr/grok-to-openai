"""SQLite-backed multi-turn conversation state.

Maps OpenAI-side conversations (client key or previous_response_id) to a
grok conversation + the last-seen message history. Turns are appended to
the SAME grok conversation (server-side state), so follow-ups send only
the delta instead of re-sending the whole history.

Client key derivation (in server.py):
  chat completions : explicit `user` field, else hash of (model, first
                     user message) -> stable across turns of one chat.
  responses api    : `previous_response_id` lineage, else `user`/first input.
"""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    client_key      TEXT PRIMARY KEY,
    account_index   INTEGER NOT NULL,
    grok_session_id TEXT NOT NULL,
    conversation_id TEXT,
    model           TEXT NOT NULL,
    history         TEXT NOT NULL DEFAULT '[]',
    created_at      REAL NOT NULL,
    updated_at      REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS response_ids (
    response_id TEXT PRIMARY KEY,
    client_key  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_response_client ON response_ids(client_key);
"""


class SessionStore:
    def __init__(self, path: str | Path = "grok_sessions.db"):
        self.path = Path(path).resolve()
        self._lock = __import__("threading").Lock()
        self._conn = None
        self._connect()

    def _connect(self) -> None:
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def _execute(self, sql: str, params=()):
        with self._lock:
            try:
                cur = self._conn.execute(sql, params)
                self._conn.commit()
                return cur
            except sqlite3.OperationalError:
                # file replaced/renamed underneath us (e.g. manual reset)
                self._connect()
                cur = self._conn.execute(sql, params)
                self._conn.commit()
                return cur

    # ---- sessions ------------------------------------------------------

    def get_session(self, client_key: str) -> dict | None:
        cur = self._execute("SELECT * FROM sessions WHERE client_key = ?", (client_key,))
        row = cur.fetchone()
        if row is None:
            return None
        d = dict(row)
        d["history"] = json.loads(d.get("history") or "[]")
        return d

    def create_session(self, client_key: str, account_index: int, grok_session_id: str,
                       conversation_id: str | None, model: str, history: list) -> None:
        now = time.time()
        self._execute(
            "INSERT OR REPLACE INTO sessions "
            "(client_key, account_index, grok_session_id, conversation_id, model, history, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (client_key, account_index, grok_session_id, conversation_id, model,
             json.dumps(history), now, now),
        )

    def update_session(self, client_key: str, conversation_id: str | None,
                       history: list) -> None:
        self._execute(
            "UPDATE sessions SET conversation_id = ?, history = ?, updated_at = ? WHERE client_key = ?",
            (conversation_id, json.dumps(history), time.time(), client_key),
        )

    def update_conversation_id(self, client_key: str, conversation_id: str | None) -> None:
        self._execute(
            "UPDATE sessions SET conversation_id = ?, updated_at = ? WHERE client_key = ?",
            (conversation_id, time.time(), client_key),
        )

    def delete_session(self, client_key: str) -> None:
        self._execute("DELETE FROM sessions WHERE client_key = ?", (client_key,))
        self._execute("DELETE FROM response_ids WHERE client_key = ?", (client_key,))

    # ---- response id lineage ------------------------------------------

    def register_response(self, response_id: str, client_key: str) -> None:
        self._execute(
            "INSERT OR REPLACE INTO response_ids (response_id, client_key) VALUES (?, ?)",
            (response_id, client_key),
        )

    def client_key_for_response(self, response_id: str) -> str | None:
        cur = self._execute("SELECT client_key FROM response_ids WHERE response_id = ?",
                            (response_id,))
        row = cur.fetchone()
        return row["client_key"] if row else None


def new_id(prefix: str) -> str:
    return f"{prefix}{uuid.uuid4().hex}"
