"""Small local store backing the OpenAI-compatible /v1/files endpoint."""
from __future__ import annotations

import json
import mimetypes
import os
import secrets
import time
from pathlib import Path


class OpenAIFileStore:
    def __init__(self, root: str | Path = ".openai_files"):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _meta_path(self, file_id: str) -> Path:
        return self.root / f"{file_id}.json"

    def _data_path(self, file_id: str) -> Path:
        return self.root / f"{file_id}.bin"

    def create(self, data: bytes, filename: str, mime_type: str | None,
               purpose: str = "assistants") -> dict:
        file_id = "file-" + secrets.token_urlsafe(18).rstrip("=")
        mime_type = mime_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
        now = int(time.time())
        meta = {
            "id": file_id,
            "object": "file",
            "bytes": len(data),
            "created_at": now,
            "filename": filename,
            "purpose": purpose,
            "status": "processed",
            "status_details": None,
            "mime_type": mime_type,
        }
        self._data_path(file_id).write_bytes(data)
        self._meta_path(file_id).write_text(json.dumps(meta), encoding="utf-8")
        return meta

    def get(self, file_id: str) -> tuple[dict, bytes] | None:
        mp = self._meta_path(file_id)
        dp = self._data_path(file_id)
        if not mp.exists() or not dp.exists():
            return None
        return json.loads(mp.read_text(encoding="utf-8")), dp.read_bytes()

    def metadata(self, file_id: str) -> dict | None:
        item = self.get(file_id)
        return item[0] if item else None

    def delete(self, file_id: str) -> bool:
        found = self._meta_path(file_id).exists() or self._data_path(file_id).exists()
        self._meta_path(file_id).unlink(missing_ok=True)
        self._data_path(file_id).unlink(missing_ok=True)
        return found

    def list(self) -> list[dict]:
        out = []
        for p in self.root.glob("file-*.json"):
            try:
                out.append(json.loads(p.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        return sorted(out, key=lambda x: x.get("created_at", 0), reverse=True)
