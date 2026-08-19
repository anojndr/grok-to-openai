"""File upload to grok.com (upload-file-v2, SINGLE_PUT flow).

Verified live: init -> PUT bytes to presigned GCS URL (with required
headers) -> complete -> fileMetadataId usable in WS items as
{"type": "input_file", "file_id": ..., "filename": ...}.

Supports every file kind: text, JSON, py, images, archives, etc. Images
uploaded through the same path and attached as input_file parts.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import mimetypes
import uuid

import httpx

log = logging.getLogger("grok.files")

UPLOAD_INIT = "https://grok.com/rest/app-chat/upload-file-v2/init"
UPLOAD_COMPLETE = "https://grok.com/rest/app-chat/upload-file-v2/complete"
UPLOAD_STATUS = "https://grok.com/rest/app-chat/upload-file-v2/status"

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
)

_HEADERS_CACHE: dict[str, dict[str, str]] = {}


def _base_headers(account) -> dict[str, str]:
    return {
        "User-Agent": USER_AGENT,
        "Cookie": account.cookie_header,
        "Origin": "https://grok.com",
        "Referer": "https://grok.com/",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


async def upload_bytes(account, data: bytes, filename: str, mime: str | None = None,
                       client: httpx.AsyncClient | None = None) -> dict:
    """Upload raw bytes; returns the grok fileMetadata (with fileMetadataId)."""
    if mime is None:
        mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    owns_client = client is None
    if owns_client:
        client = httpx.AsyncClient(timeout=120)
    try:
        headers = _base_headers(account)
        r = await client.post(UPLOAD_INIT, headers=headers,
                              json={"fileName": filename, "fileMimeType": mime,
                                    "sizeBytes": len(data)})
        if r.status_code != 200:
            raise RuntimeError(f"upload init failed: {r.status_code} {r.text[:300]}")
        init = r.json()
        sp = init.get("singlePut")
        if not sp or not sp.get("url"):
            raise RuntimeError(f"unexpected upload method: {init.get('uploadMethod')}")
        put_headers = {"Content-Type": mime}
        req_headers = sp.get("requiredHeaders") or {}
        if isinstance(req_headers, dict):
            for k, v in req_headers.items():
                if k.lower() != "content-length":  # httpx sets it
                    put_headers[k] = str(v)
        pr = await client.put(sp["url"], content=data, headers=put_headers)
        if pr.status_code not in (200, 201):
            raise RuntimeError(f"upload put failed: {pr.status_code} {pr.text[:200]}")
        cr = await client.post(UPLOAD_COMPLETE, headers=headers,
                               json={"presigned": {"uploadId": init["uploadId"],
                                                   "completedParts": []}})
        if cr.status_code != 200:
            raise RuntimeError(f"upload complete failed: {cr.status_code} {cr.text[:300]}")
        meta = cr.json().get("fileMetadata") or {}
        if not meta.get("fileMetadataId"):
            raise RuntimeError(f"upload complete missing fileMetadata: {cr.text[:300]}")
        # The upload completion response can precede parsing/indexing. Poll
        # the upstream status endpoint so file attachments are ready before
        # the chat request references the metadata id.
        for _ in range(20):
            try:
                sr = await client.get(UPLOAD_STATUS, headers={k: v for k, v in headers.items() if k != "Content-Type"},
                                       params={"uploadId": init["uploadId"]})
                status = sr.json() if sr.status_code == 200 else {}
                ready = status.get("fileMetadata") or {}
                if ready.get("fileMetadataId"):
                    meta = ready
                    break
                if str(status.get("status", "")).upper().endswith(("ERROR", "FAILED")):
                    break
            except Exception:
                pass
            await asyncio.sleep(0.25)
        return meta
    finally:
        if owns_client:
            await client.aclose()


async def upload_bytes_many(account, files: list[tuple[bytes, str, str | None]]) -> list[dict]:
    """Upload several files concurrently for one account."""
    async with httpx.AsyncClient(timeout=120) as client:
        results = await asyncio.gather(
            *(upload_bytes(account, data, name, mime, client) for data, name, mime in files),
            return_exceptions=True,
        )
    metas = []
    for r in results:
        if isinstance(r, Exception):
            log.warning("file upload failed: %s", r)
            continue
        metas.append(r)
    return metas


def mime_from_name(filename: str) -> str:
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"


def parse_data_url(data_url: str) -> tuple[bytes, str, str]:
    """data:<mime>;base64,<payload> -> (bytes, mime, filename)."""
    m = data_url.split(",", 1)
    if len(m) != 2:
        raise ValueError("invalid data URL")
    meta, payload = m
    mime = "application/octet-stream"
    if ";" in meta:
        mime = meta.split(":", 1)[1].split(";")[0]
    if meta.endswith(";base64") or ";base64" in meta:
        data = base64.b64decode(payload)
    else:
        data = payload.encode()
    ext = mimetypes.guess_extension(mime) or ".bin"
    return data, mime, f"attachment{ext}"
