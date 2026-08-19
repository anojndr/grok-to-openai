"""PixelVault image hosting for Grok-generated images.

Docs: https://pixelvault.dev/docs/  (POST /v1/images, Bearer key).
API key comes from $PIXELVAULT_API_KEY, falling back to the `.env` file
in the repo root. Without a key, uploads are skipped and the original
CDN URL passes through. Uploads are fail-open: any failure returns None
and the caller falls back to the original CDN URL.
"""
from __future__ import annotations

import logging
import mimetypes
import os
from pathlib import Path
from urllib.parse import unquote, urlparse

import httpx

from files import parse_data_url

log = logging.getLogger("grok.pixelvault")

API_BASE = "https://api.pixelvault.dev"


def _load_env_file() -> None:
    """Tiny .env loader (no dependency). Existing env vars win."""
    path = Path(__file__).resolve().parent / ".env"
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        pass


_load_env_file()

API_KEY = os.environ.get("PIXELVAULT_API_KEY")
_TIMEOUT = httpx.Timeout(120.0, connect=20.0)


async def pixelvault_url(url: str) -> str | None:
    """Host one image on PixelVault; return the CDN URL, or None on failure."""
    if not url:
        return None
    if not API_KEY:
        log.warning("no PIXELVAULT_API_KEY configured; passing through original URL")
        return None
    try:
        if url.startswith("data:"):
            data, mime, filename = parse_data_url(url)
            return await _upload_bytes(data, filename, mime)
        hosted = await _upload_url(url)
        if hosted:
            return hosted
        data, mime = await _download(url)
        if data:
            return await _upload_bytes(data, _filename(url, mime), mime)
    except Exception as exc:
        log.warning("pixelvault upload failed for %s: %s", url[:120], exc)
    return None


async def _post(path: str, **kwargs) -> dict | None:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.post(
            f"{API_BASE}{path}",
            headers={"Authorization": f"Bearer {API_KEY}"},
            **kwargs,
        )
        if not response.is_success:
            log.warning("pixelvault %s -> HTTP %s: %s",
                        path, response.status_code, response.text[:200])
            return None
        body = response.json()
        return (body or {}).get("data") or {}


async def _upload_url(url: str) -> str | None:
    """Upload via URL (server-side fetch): one request, no download."""
    data = await _post("/v1/images", json={"url": url})
    return (data or {}).get("url")


async def _upload_bytes(data: bytes, filename: str, mime: str) -> str | None:
    data = await _post("/v1/images",
                       files={"file": (filename, data, mime or "application/octet-stream")})
    return (data or {}).get("url")


async def _download(url: str) -> tuple[bytes, str]:
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response.content, response.headers.get("content-type", "").split(";")[0]


def _filename(url: str, mime: str) -> str:
    name = unquote(urlparse(url).path.rsplit("/", 1)[-1])
    if "." not in name:
        name = "image" + (mimetypes.guess_extension(mime or "") or ".png")
    return name or "image.png"