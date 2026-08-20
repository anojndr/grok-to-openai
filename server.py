"""OpenAI-compatible FastAPI facade for grok.com.

The upstream chat transport is grok's JSON WebSocket gateway. Each request
uses real conversation items (text and uploaded files), while local SQLite
state supplies prior turns when an OpenAI client sends a follow-up. The
upstream gateway's conversation attach operation is not reliable for
sessions created by this client, so each turn uses a fresh upstream session
and replays history as separate items; this is deliberately not one prompt.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import mimetypes
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from accounts import Account, AccountPool
from files import mime_from_name, parse_data_url, upload_bytes
from grok_client import GrokError, GrokSessionManager, GrokTurn, normalize_model
from grok_imagine import aspect_ratio, generate_images
from openai_files import OpenAIFileStore
from pixelvault import pixelvault_url
from session_store import SessionStore, new_id

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("grok.server")

PORT = int(os.environ.get("GROK_PORT", "15553"))
ACCOUNTS_FILE = os.environ.get("GROK_ACCOUNTS_FILE", "accounts.txt")
DB_PATH = os.environ.get("GROK_DB", "grok_sessions.db")
API_KEY = os.environ.get("GROK_OPENAI_API_KEY") or None
INCLUDE_SOURCES = os.environ.get("GROK_INCLUDE_SOURCES", "0").strip().lower() in ("1", "true", "yes", "on")
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
HTTP_TIMEOUT = httpx.Timeout(120.0, connect=20.0)

pool = AccountPool(ACCOUNTS_FILE)
store = SessionStore(DB_PATH)
manager = GrokSessionManager()
file_store = OpenAIFileStore(os.environ.get("GROK_FILES_DIR", ".openai_files"))
_client_locks: dict[str, asyncio.Lock] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("grok-openai proxy starting with %d accounts", pool.count())
    reload_task = asyncio.create_task(_reload_loop())
    probe_task = asyncio.create_task(_probe_loop())
    yield
    reload_task.cancel()
    probe_task.cancel()
    await manager.close_all()


app = FastAPI(title="grok-to-openai", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


async def _reload_loop():
    while True:
        await asyncio.sleep(5)
        try:
            before = pool.count()
            pool.reload()
            if before != pool.count():
                log.info("accounts.txt changed: %d -> %d accounts", before, pool.count())
        except Exception as exc:
            log.warning("account reload failed: %s", exc)


async def _probe_loop():
    # REST rate-limit checks do not create expensive chat sessions. Probes
    # run concurrently over one shared client (connection pooling, no serial
    # handshakes), and unhealthy accounts are re-probed every 60s so a
    # recovered account rejoins rotation within a minute instead of five.
    while True:
        try:
            now = time.monotonic()
            due = [a for a in pool.accounts()
                   if a.last_probe == 0 or now - a.last_probe >= (60 if not a.healthy else 1800)]
            if due:
                async with httpx.AsyncClient(timeout=30) as client:
                    # Probe in small parallel batches: a startup/reload burst
                    # of 20 accounts hitting the REST endpoint at once could
                    # look like scraping. Each probe isolates its own
                    # exceptions, so one failure cannot abort the batch.
                    for i in range(0, len(due), 8):
                        await asyncio.gather(*(_probe_account(a, client) for a in due[i:i + 8]))
        except Exception as exc:
            log.warning("account probe loop failed: %s", exc)
        await asyncio.sleep(60)


async def _probe_account(account: Account, client: httpx.AsyncClient) -> None:
    account.last_probe = time.monotonic()
    try:
        response = await client.post(
            "https://grok.com/rest/rate-limits",
            headers={
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36",
                "Cookie": account.cookie_header,
                "Origin": "https://grok.com",
                "Content-Type": "application/json",
            },
            json={"modelName": "fast"},
        )
        if response.status_code == 200:
            data = response.json()
            remaining = data.get("remainingQueries")
            if remaining is not None:
                account.remaining_queries = int(remaining)
            if remaining is not None and remaining <= 0:
                # Keep the account out of rotation until quota resets;
                # the probe loop revives it (healthy=False -> 60s probes).
                # A long cooldown stops pick()'s fallback from re-selecting
                # it while every account is exhausted.
                account.healthy = False
                pool.report_failure(account, "quota exhausted (0 remaining queries)")
                account.cooldown_until = time.monotonic() + 3600
            else:
                pool.report_success(account)
        else:
            pool.report_failure(account, f"rate-limit probe HTTP {response.status_code}")
    except Exception as exc:
        pool.report_failure(account, f"rate-limit probe: {exc}")


async def _check_auth(request: Request) -> None:
    if API_KEY is not None and request.headers.get("Authorization") != f"Bearer {API_KEY}":
        raise GrokError("invalid API key", code=401, kind="auth_error")


# ---------------------------------------------------------------------------
# Conversation keys and normalized input
# ---------------------------------------------------------------------------


def _hash(*parts: str) -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(str(part).encode("utf-8", errors="replace"))
        h.update(b"\0")
    return h.hexdigest()[:24]


def _item_text(item: dict) -> str:
    return "".join(
        p.get("text", "") for p in item.get("parts", [])
        if p.get("type") in ("text", "input_text")
    )


def _first_user_text(items: list[dict]) -> str:
    for item in items:
        if item.get("role") in ("user", "developer"):
            return _item_text(item)[:300]
    return ""


def _chat_key(model: str, history: list[dict], user: str | None) -> str:
    return f"chat:user:{_hash(user)}" if user else f"chat:auto:{_hash(model, _first_user_text(history))}"


def _responses_key(model: str, items: list[dict], user: str | None,
                   previous_response_id: str | None) -> str:
    if previous_response_id:
        found = store.client_key_for_response(previous_response_id)
        if found:
            return found
    return f"resp:user:{_hash(user)}" if user else f"resp:auto:{_hash(model, _first_user_text(items))}"


def _chat_parts(message: dict) -> list[dict]:
    content = message.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if content is None:
        return [{"type": "text", "text": ""}]
    if not isinstance(content, list):
        return [{"type": "text", "text": str(content)}]
    parts = []
    for part in content:
        if isinstance(part, str):
            parts.append({"type": "text", "text": part})
        elif isinstance(part, dict):
            ptype = part.get("type")
            if ptype in ("text", "input_text"):
                parts.append({"type": "text", "text": part.get("text", "")})
            elif ptype in ("image_url", "file", "input_file", "file_url"):
                parts.append(part)
            else:
                parts.append({"type": "text", "text": json.dumps(part)})
    return parts or [{"type": "text", "text": ""}]


async def _responses_items(input_data: Any) -> list[dict]:
    if isinstance(input_data, str):
        return [{"role": "user", "parts": [{"type": "text", "text": input_data}]}]
    if isinstance(input_data, dict):
        input_data = [input_data]
    items: list[dict] = []
    for raw in input_data or []:
        if not isinstance(raw, dict):
            continue
        ptype = raw.get("type", "message")
        if ptype == "message":
            role = raw.get("role", "user")
            role = "system" if role in ("system", "developer") else role
            content = raw.get("content", [])
            content = content if isinstance(content, list) else [content]
            parts = []
            for part in content:
                if isinstance(part, str):
                    parts.append({"type": "text", "text": part})
                elif isinstance(part, dict):
                    p = dict(part)
                    if p.get("type") == "input_image":
                        # OpenAI inputs reference uploaded images either by
                        # URL/data URL or by local file_id (post /v1/files).
                        # A file_id is resolved through the local store the
                        # same way input_file parts are; dropping it here
                        # silently loses the image upstream.
                        if p.get("file_id"):
                            # Carry any inline URL/data as a fallback: a
                            # file_id that fails to resolve upstream (or is
                            # absent from the local store) must not torpedo
                            # a request that also supplied a usable image.
                            img = p.get("image_url") or p.get("image_data")
                            if isinstance(img, dict):
                                img = img.get("url")
                            is_data = isinstance(img, str) and img.startswith("data:")
                            parts.append({
                                "type": "input_file",
                                "file_id": p.get("file_id"),
                                "filename": p.get("filename"),
                                "file": {"data": img if is_data else None,
                                         "url": img if not is_data else None,
                                         "filename": p.get("filename"),
                                         "mime_type": p.get("mime_type")},
                            })
                        else:
                            url = p.get("image_url") or p.get("image_data")
                            parts.append({"type": "image_url", "image_url": url})
                    elif p.get("type") == "input_file":
                        parts.append({
                            "type": "input_file",
                            "file_id": p.get("file_id"),
                            "filename": p.get("filename"),
                            "file": {
                                "data": p.get("file_data"),
                                "url": p.get("file_url"),
                                "filename": p.get("filename"),
                                "mime_type": p.get("mime_type"),
                            },
                        })
                    else:
                        parts.append(p)
            items.append({"role": role, "parts": parts})
        elif ptype in ("function_call", "function_call_output", "reasoning"):
            role = "assistant" if ptype != "function_call_output" else "user"
            items.append({"role": role, "parts": [{"type": "text", "text": json.dumps(raw)}]})
    return items or [{"role": "user", "parts": [{"type": "text", "text": ""}]}]


async def _download_url(url: str) -> tuple[bytes, str]:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True) as client:
        response = await client.get(url)
        response.raise_for_status()
        if len(response.content) > MAX_ATTACHMENT_BYTES:
            raise GrokError("attachment exceeds 20 MiB", code=400, kind="file_too_large")
        return response.content, response.headers.get("content-type", "application/octet-stream").split(";")[0]


async def _file_part(account: Account, part: dict) -> dict:
    inner = part.get("file")
    if inner is None and part.get("file_data") is not None:
        inner = {"data": part.get("file_data"), "filename": part.get("filename"),
                 "mime_type": part.get("mime_type")}
    inner = inner or {}
    if not isinstance(inner, dict):
        inner = {}
    filename = inner.get("filename") or part.get("filename") or "attachment.bin"
    mime = inner.get("mime_type") or inner.get("file_type") or mime_from_name(filename)
    data = None
    inline_data = inner.get("data") or inner.get("file_data")
    remote_url = inner.get("url") or inner.get("file_url")
    if inline_data:
        value = inline_data
        if isinstance(value, str) and value.startswith("data:"):
            data, mime, data_name = parse_data_url(value)
            if not filename or filename == "attachment.bin":
                filename = data_name
        else:
            data = base64.b64decode(value)
    elif remote_url:
        data, mime = await _download_url(remote_url)
    elif part.get("file_id"):
        file_id = str(part["file_id"])
        local = file_store.get(file_id)
        if local:
            meta, data = local
            filename = meta.get("filename") or filename
            mime = meta.get("mime_type") or mime
        else:
            # Never forward an OpenAI file_id to grok as if it were a grok
            # fileMetadataId: grok silently drops unknown ids and answers as
            # if no attachment existed. Fail loudly instead.
            raise GrokError(
                f"unknown file_id {file_id!r}: upload it to /v1/files first",
                code=400, kind="bad_file")
    if data is None:
        raise GrokError("file part requires file_data, file_url, or file_id", code=400, kind="bad_file")
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise GrokError("attachment exceeds 20 MiB", code=400, kind="file_too_large")
    meta = await upload_bytes(account, data, filename, mime)
    return {"type": "input_file", "file_id": meta["fileMetadataId"], "filename": filename}


async def _image_part(account: Account, part: dict) -> dict:
    url = part.get("image_url")
    if isinstance(url, dict):
        url = url.get("url")
    if not url:
        raise GrokError("image_url requires a URL or data URL", code=400, kind="bad_image")
    if url.startswith("data:"):
        data, mime, filename = parse_data_url(url)
    else:
        data, mime = await _download_url(url)
        filename = "image" + (mimetypes.guess_extension(mime) or ".bin")
    meta = await upload_bytes(account, data, filename, mime)
    return {"type": "input_file", "file_id": meta["fileMetadataId"], "filename": filename}


async def _to_grok_content(account: Account, parts: list[dict]) -> list[dict]:
    content = []
    for part in parts:
        ptype = part.get("type", "")
        if ptype in ("text", "input_text"):
            content.append({"type": "input_text", "text": part.get("text", "")})
        elif ptype == "image_url":
            content.append(await _image_part(account, part))
        elif ptype in ("file", "input_file", "file_url"):
            content.append(await _file_part(account, part))
    return content or [{"type": "input_text", "text": ""}]


# ---------------------------------------------------------------------------
# Upstream orchestration
# ---------------------------------------------------------------------------


def _history_prefix(stored: list[dict], current: list[dict]) -> bool:
    return len(current) >= len(stored) and stored == current[:len(stored)]


def _prepend_text(item: dict, prefix: str) -> dict:
    """Prefix text onto an item while keeping its non-text parts intact.

    The context folds below build one combined text from the existing text
    parts; replacing the parts list outright would silently drop any images
    or files attached to the message.
    """
    kept = [p for p in item.get("parts", [])
            if p.get("type") not in ("text", "input_text")]
    return {**item, "parts": [{"type": "text", "text": prefix}] + kept}


async def _replay(account: Account, turn: GrokTurn, history: list[dict]) -> tuple[list[str], dict | None]:
    """Send history as separate items; fold assistant output into the next
    user item because grok accepts user input items as context reliably."""
    items = []
    system = []
    for item in history:
        if item.get("role") == "system":
            system.append(_item_text(item))
        else:
            items.append(item)
    if system:
        text = "[system]\n" + "\n\n".join(system) + "\n[/system]"
        if items:
            items[0] = _prepend_text(items[0], text + "\n\n" + _item_text(items[0]))
        else:
            items = [{"role": "user", "parts": [{"type": "text", "text": text}]}]
    folded = []
    pending = []
    for item in items:
        if item.get("role") == "assistant":
            pending.append(_item_text(item))
            continue
        if pending and item.get("role") == "user":
            context = "\n".join(f"[Previous assistant response: {text}]" for text in pending)
            item = _prepend_text(item, context + "\n\n" + _item_text(item))
            pending = []
        folded.append(item)
    if pending and folded:
        folded[-1] = _prepend_text(
            folded[-1],
            _item_text(folded[-1]) + "\n\n[Previous assistant response: " + pending[-1] + "]")
    file_ids: list[str] = []
    response_item = None
    last_index = len(folded) - 1
    for index, item in enumerate(folded):
        role = item.get("role", "user")
        role = role if role in ("user", "assistant", "system") else "user"
        content = await _to_grok_content(account, item.get("parts", []))
        ids = [p["file_id"] for p in content if p.get("type") == "input_file" and p.get("file_id")]
        file_ids.extend(ids)
        # Grok's web client sends the final file-bearing user message as the
        # `item` on response.create, not as conversation.item.create.
        if ids and index == last_index and role == "user":
            text_content = [p for p in content if p.get("type") != "input_file"]
            response_item = {"type": "message", "role": "user",
                             "content": text_content or [{"type": "input_text", "text": ""}]}
            continue
        await turn.add_item({"type": "message", "role": role, "content": content})
    return file_ids, response_item


# Upper bound on upstream attempts per request. The first attempt is one
# account; after a failure, each round races RACE_ACCOUNTS sessions at once
# so a request's wall time tracks the fastest working account instead of
# the sum of every failing account's timeout.
MAX_ATTEMPTS = 6
RACE_ACCOUNTS = 4


async def _race_attempts(client_key: str, model: str, history: list[dict], on_delta,
                         accounts: list[Account]) -> tuple[tuple | None, Exception | None]:
    """Run the turn on one of `accounts`, racing session setup.

    Every account's connection + session.create run concurrently and the
    first account whose session becomes ready carries the full turn (replay,
    generate, streaming) — so when several accounts are failing, the request
    pays only the fastest account's setup time. Accounts whose preflight
    actually failed are reported to the pool (cooldown/health); accounts
    that merely lost the race are closed quietly and stay healthy. Every
    acquired slot is released exactly once, on every path (including outer
    cancellation), so racing never leaks load or connections. Deterministic
    client errors (GrokError 4xx) never penalize an account: they would fail
    on any account identically.

    Returns (result, None) on success or (None, error) on failure; any
    genuinely failing account has already been reported to the pool.
    """
    async def preflight(acc: Account) -> tuple[Account, GrokTurn | None, BaseException | None]:
        try:
            return acc, await manager.new_turn(acc, model, None), None
        except BaseException as exc:
            return acc, None, exc

    async def close_turn_bounded(turn: GrokTurn) -> None:
        """Close a turn without letting an unresponsive peer stall teardown.

        websockets' close() waits up to close_timeout for the peer's close
        frame; a silent-but-connected gateway (the exact failing-account
        case) would otherwise block each close for ~10s on the winner's
        critical path. Cancellation always propagates — never swallow it.
        """
        try:
            await asyncio.wait_for(manager.close_turn(turn), 1.5)
        except asyncio.TimeoutError:
            pass
        except Exception:
            pass

    winner: tuple[Account, GrokTurn] | None = None
    failures: list[tuple[Account, BaseException]] = []
    released: set[int] = set()
    closed_turns: set[int] = set()

    def release_once(acc: Account) -> None:
        if id(acc) not in released:
            released.add(id(acc))
            pool.release(acc)

    async def close_turn_once(turn: GrokTurn) -> None:
        if id(turn) not in closed_turns:
            closed_turns.add(id(turn))
            await close_turn_bounded(turn)

    pending = {asyncio.create_task(preflight(a)): a for a in accounts}
    winner_cleaned = False
    try:
        # Phase 1: race until a success settles or every preflight settles.
        # asyncio.wait returns EVERY task that completed by the time it
        # resumes, not just one — process the whole batch so no ready
        # session, failed preflight, or slot is dropped.
        while pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for t in done:
                acc, turn, exc = t.result()
                if exc is not None:
                    failures.append((acc, exc))
                    continue
                if winner is None:
                    winner = (acc, turn)
                else:
                    # Another session became ready in the same wakeup — it
                    # lost; discard it now so no connection or slot leaks.
                    await close_turn_once(turn)
                    release_once(acc)
            if winner is not None:
                break
        # Phase 2: settle the remaining racers (cancelled or finished late).
        for t in pending:
            t.cancel()
        loser_turns: list[GrokTurn] = []
        for res in await asyncio.gather(*pending, return_exceptions=True):
            if isinstance(res, BaseException):
                continue
            acc, turn, exc = res
            if exc is not None and not isinstance(exc, asyncio.CancelledError):
                failures.append((acc, exc))
            if turn is not None:
                loser_turns.append(turn)
            release_once(acc)
        if loser_turns:
            await asyncio.gather(*(close_turn_once(t) for t in loser_turns))
        # Report genuine account failures; never penalize a deterministic
        # client error (4xx) — it would fail on any account the same way.
        for acc, exc in failures:
            if isinstance(exc, GrokError) and 400 <= exc.code < 500:
                continue
            pool.report_failure(acc, str(exc)[:160])
            release_once(acc)
        if winner is None:
            real = [e for _, e in failures
                    if not (isinstance(e, GrokError) and 400 <= e.code < 500)]
            if not real:
                raise GrokError("preflight race produced no result", kind="cancelled")
            return None, real[-1]
        acc, turn = winner
        try:
            file_ids, response_item = await _replay(acc, turn, history)
            text, images, sources = await turn.generate(on_delta, file_attachment_ids=file_ids or None,
                                                        item=response_item)
            store.create_session(client_key, acc.index, turn.session_id, turn.conversation_id, model, history)
            pool.report_success(acc)
            return (text, images, sources), None
        except Exception as exc:
            if not (isinstance(exc, GrokError) and 400 <= exc.code < 500):
                pool.report_failure(acc, str(exc)[:160])
            return None, exc
        finally:
            winner_cleaned = True
            await close_turn_once(turn)
            release_once(acc)
    finally:
        # Outer cancellation (or any exceptional exit): cancel stragglers,
        # close the winner if the inner cleanup never ran, and release every
        # slot. All helpers are idempotent, so this is exactly-once safe.
        for t in pending:
            t.cancel()
        if pending:
            for res in await asyncio.gather(*pending, return_exceptions=True):
                if isinstance(res, BaseException):
                    continue
                acc2, turn2, exc2 = res
                if turn2 is not None:
                    await close_turn_once(turn2)
                release_once(acc2)
        if winner is not None and not winner_cleaned:
            await close_turn_once(winner[1])
            release_once(winner[0])
        for acc in accounts:
            release_once(acc)


async def _run_turn(client_key: str, model: str, history: list[dict], on_delta) -> tuple[str, list[dict], list[dict]]:
    """Run one chat turn. Returns (text, image parts, web sources).

    The first attempt is a single account (the pinned conversation account,
    else the least-loaded account). On failure, later attempts race several
    accounts' session setup concurrently so failing accounts never serialize
    a request behind their timeouts.
    """
    last: Exception | None = None
    for attempt in range(MAX_ATTEMPTS):
        row = store.get_session(client_key)
        accounts: list[Account] = []
        if row and _history_prefix(row["history"], history):
            pinned = next((a for a in pool.accounts() if a.index == row["account_index"] and a.healthy), None)
            if pinned is not None:
                pinned.in_flight += 1
                accounts = [pinned]
        if not accounts:
            # Rewind/edit (or the pinned account is gone): discard the pinned
            # conversation and try fresh accounts.
            row = None
            n = 1 if attempt == 0 else RACE_ACCOUNTS
            accounts = await pool.acquire_many(n)
            if not accounts:
                # Pool exhausted (every account cooling down): a capacity
                # problem, not an upstream failure — always 503 so clients
                # treat it as retryable, never 502.
                raise GrokError("no healthy grok accounts available", code=503, kind="no_accounts")
        result, error = await _race_attempts(client_key, model, history, on_delta, accounts)
        if error is None:
            return result
        last = error
        if isinstance(error, GrokError) and 400 <= error.code < 500:
            # Client-caused and deterministic (bad file, bad image,
            # oversized attachment): another account cannot succeed,
            # and retrying would burn accounts on the same request.
            raise error
        store.delete_session(client_key)
    raise GrokError(f"all accounts failed: {last}", code=502, kind="all_accounts_failed")


# ---------------------------------------------------------------------------
# Image output
# ---------------------------------------------------------------------------
# grok.com generates images on the dedicated imagine channel
# (grok_imagine.py); the chat gateway is text-only. A chat request whose
# last user message asks for an image is routed there, and every generated
# image URL is re-hosted on PixelVault before it is returned to the client.

IMAGE_VERB = r"(?:generate|create|draw|paint|render|produce|sketch|design|make)"
IMAGE_NOUN = (r"(?:image|picture|pic|photo|photograph|illustration|drawing|painting|"
              r"sketch|artwork|art|logo|wallpaper|poster|meme|avatar|portrait|graphic|"
              r"icon|thumbnail|banner|comic|cartoon|manga|anime|cat|dog|animal|landscape|scene)")
IMAGE_INTENT_RE = re.compile(rf"\b{IMAGE_VERB}\b[^\n.!?]{{0,80}}\b{IMAGE_NOUN}\b", re.IGNORECASE)
# Text framing that must NOT route to the imagine channel: the user is
# asking ABOUT images, not for one. Guards against burning image quota on
# questions ("how do I generate an image description…") and software talk
# ("create a test plan for the image upload feature").
IMAGE_TEXT_RE = re.compile(
    r"\b(?:how|why|what|which|when|where|explain|describe|summarize|summarise|"
    r"summary|analysis|overview|recap|guide|list|tell me|compare|define)\b",
    re.IGNORECASE)
IMAGE_FEATURE_RE = re.compile(
    r"\b(?:image|picture|photo|art|icon|thumbnail|banner|logo|graphic|drawing|painting)\b"
    r"\s+(?:upload|processing|pipeline|feature|api|schema|documentation|docs|"
    r"generation|tool|workflow|test|caption|description|alt|analysis)\b",
    re.IGNORECASE)


def _user_text(items: list[dict]) -> str:
    for item in reversed(items):
        if item.get("role") in ("user", "developer"):
            return _item_text(item)
    return ""


def _image_intent(items: list[dict]) -> str | None:
    text = _user_text(items)
    if not text or not IMAGE_INTENT_RE.search(text):
        return None
    if IMAGE_TEXT_RE.search(text) or IMAGE_FEATURE_RE.search(text):
        return None
    return text


def _image_tail(text: str, urls: list[str]) -> str:
    """Markdown link suffix appended to text so the URL is part of the output."""
    if not urls:
        return ""
    links = "\n".join(f"![image]({u})" for u in urls)
    return ("\n" if text else "") + links


async def _host_images(images: list[dict]) -> list[str]:
    """Upload Grok images to PixelVault; fall back to the original URL."""
    urls = [img["url"] for img in images if img.get("url")]
    if not urls:
        return []
    hosted = await asyncio.gather(*(pixelvault_url(u) for u in urls))
    return [pv or orig for pv, orig in zip(hosted, urls)]


async def _run_image_turn(prompt: str, n: int = 1, aspect: str = "1:1") -> list[dict]:
    """Generate images via the imagine channel with cross-account retry."""
    last: Exception | None = None
    for _ in range(3):
        account = await pool.acquire()
        if account is None:
            raise GrokError("no healthy grok accounts available", code=503, kind="no_accounts")
        try:
            imgs = await generate_images(account, prompt, n=n, aspect=aspect)
            pool.report_success(account)
            return imgs
        except Exception as exc:
            last = exc
            pool.report_failure(account, str(exc)[:160])
            if isinstance(exc, GrokError) and exc.kind in ("moderated", "imagine_error"):
                # Prompt-level rejection: another account cannot succeed and
                # a retry would burn another image generation.
                raise
        finally:
            pool.release(account)
    raise GrokError(f"image generation failed: {last}", code=502, kind="image_generation_failed")


# ---------------------------------------------------------------------------
# OpenAI response shaping
# ---------------------------------------------------------------------------


SOURCE_APPENDIX_MAX = 50


def _include_sources(flag: Any) -> bool:
    """Per-request override; falls back to the GROK_INCLUDE_SOURCES env flag."""
    if flag is None:
        return INCLUDE_SOURCES
    if isinstance(flag, str):
        return flag.strip().lower() in ("1", "true", "yes", "on")
    return bool(flag)


def _host_of(url: str) -> str:
    try:
        return (urlparse(url).netloc or "").lower()
    except ValueError:
        return ""


def _source_appendix(sources: list, query: str) -> str:
    """Bridge source appendix for llmcord-go's "Show Sources" button.

    Same contract as the perplexity-to-openai proxy's include_sources
    appendix: the trailing \"Sources\" block (markdown links, first-seen
    order, deduplicated upstream) plus a \"Search Queries\" footer keyed on
    the client's latest user text. Emitted only when include_sources is
    enabled, so non-llmcord clients never see it by default.
    """
    entries: list[str] = []
    # Collapse newlines/tabs so multi-line queries cannot break the
    # backtick spans or the footer, then neutralize backticks themselves.
    clean_query = " ".join(query.split()).replace("`", "'") if query else ""
    for src in sources[:SOURCE_APPENDIX_MAX]:
        if not isinstance(src, dict):
            continue
        url = (src.get("url") or "").strip().replace("\n", "").replace("\r", "").replace("\t", "")
        # llmcord-go's markdown-link regex stops at ')' and whitespace;
        # escaping '(' too keeps the destination paren-free so
        # balanced-paren parsers do not reject links like
        # cc938592(v=technet.10).
        url = url.replace("(", "%28").replace(")", "%29").replace(" ", "%20")
        if not url:
            continue
        title = " ".join(str(src.get("title") or "").split())
        title = title.replace("[", "").replace("]", "") or url
        entry = f"[{title}]({url})"
        host = _host_of(url)
        if title != url and host:
            entry += f" ({host})"
        if clean_query:
            entry += f" via `{clean_query}`"
        entries.append(entry)
    if not entries:
        return ""
    lines = ["Sources"]
    lines.extend(f"{i}. {entry}" for i, entry in enumerate(entries, start=1))
    if clean_query:
        lines.append("")
        lines.append("Search Queries")
        lines.append(f"1. `{clean_query}`")
    return "\n\n" + "\n".join(lines)


def _usage(text: str) -> dict:
    completion = max(1, len(text) // 4)
    return {"prompt_tokens": 1, "completion_tokens": completion, "total_tokens": completion + 1}


def _responses_usage(text: str) -> dict:
    # openai SDK >= 2 expects the Responses usage shape
    output = max(1, len(text) // 4)
    return {"input_tokens": 1, "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0},
            "output_tokens": output, "output_tokens_details": {"reasoning_tokens": 0},
            "total_tokens": output + 1}


def _chat_chunk(cid: str, model: str, created: int, delta: dict, finish=None) -> str:
    return "data: " + json.dumps({
        "id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }) + "\n\n"


def _chat_object(cid: str, model: str, created: int, text: str, images: list[str] = ()) -> dict:
    # content stays a plain string (markdown links): openai SDKs reject
    # part arrays in chat.completion message content.
    content = text + _image_tail(text, images)
    return {"id": cid, "object": "chat.completion", "created": created, "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
            "usage": _usage(text)}


def _response_object(rid: str, model: str, created: int, text: str, status="completed",
                     previous_response_id: str | None = None, images: list[str] = ()) -> dict:
    # output parts are text-only (markdown links carry the image URLs):
    # openai SDKs reject output_image parts in message content (union is
    # output_text | output_refusal).
    content: list[dict] = [{"type": "output_text", "text": text + _image_tail(text, images), "annotations": []}]
    return {"id": rid, "object": "response", "created_at": created, "status": status,
            "model": model, "error": None, "incomplete_details": None,
            "instructions": None, "max_output_tokens": None, "parallel_tool_calls": True,
            "previous_response_id": previous_response_id, "reasoning": {"effort": None, "summary": None},
            "store": True, "temperature": None, "text": {"format": {"type": "text"}},
            "tool_choice": "auto", "tools": [], "top_p": None, "truncation": "disabled",
            "usage": _responses_usage(text), "user": None, "metadata": {},
            "output": [{"id": new_id("msg_"), "type": "message", "role": "assistant", "status": "completed",
                        "content": content, "logprobs": []}]}


def _response_event(etype: str, seq: int, payload: dict) -> str:
    return f"event: {etype}\ndata: {json.dumps({'type': etype, 'sequence_number': seq, **payload})}\n\n"


# ---------------------------------------------------------------------------
# Chat Completions API
# ---------------------------------------------------------------------------

@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    await _check_auth(request)
    body = await request.json()
    model = normalize_model(body.get("model"))
    raw_messages = body.get("messages")
    if not isinstance(raw_messages, list) or not raw_messages:
        raise GrokError("messages must be a non-empty array", code=400, kind="bad_request")
    history = []
    for message in raw_messages:
        role = message.get("role", "user")
        role = "system" if role == "developer" else role
        history.append({"role": role, "parts": _chat_parts(message)})
    key = _chat_key(model, history, body.get("user"))
    cid = new_id("chatcmpl-")
    created = int(time.time())
    img_prompt = _image_intent(history)
    lock = _client_locks.setdefault(key, asyncio.Lock())
    async with lock:
        if body.get("stream"):
            async def stream():
                yield _chat_chunk(cid, model, created, {"role": "assistant", "content": ""})
                if img_prompt is not None:
                    try:
                        urls = await _host_images(await _run_image_turn(img_prompt))
                        yield _chat_chunk(cid, model, created, {"content": _image_tail("", urls)})
                    except Exception as exc:
                        yield "data: " + json.dumps({"error": _openai_error(exc)}) + "\n\n"
                    yield _chat_chunk(cid, model, created, {}, "stop")
                    yield "data: [DONE]\n\n"
                    return
                q: asyncio.Queue = asyncio.Queue(128)
                done = asyncio.Event()
                async def producer():
                    try:
                        async def delta(text, _event):
                            await q.put(_chat_chunk(cid, model, created, {"content": text}))
                        text, images, sources = await _run_turn(key, model, history, delta)
                        urls = await _host_images(images)
                        if urls:
                            await q.put(_chat_chunk(cid, model, created,
                                                    {"content": _image_tail(text, urls)}))
                        if _include_sources(body.get("include_sources")):
                            appendix = _source_appendix(sources, _user_text(history))
                            if appendix:
                                await q.put(_chat_chunk(cid, model, created,
                                                        {"content": appendix}))
                    except Exception as exc:
                        await q.put("data: " + json.dumps({"error": _openai_error(exc)}) + "\n\n")
                    finally:
                        done.set()
                task = asyncio.create_task(producer())
                while not done.is_set() or not q.empty():
                    try:
                        yield await asyncio.wait_for(q.get(), 0.5)
                    except asyncio.TimeoutError:
                        pass
                await task
                yield _chat_chunk(cid, model, created, {}, "stop")
                yield "data: [DONE]\n\n"
            return StreamingResponse(stream(), media_type="text/event-stream",
                                     headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
        full = []
        async def delta(text, _event):
            full.append(text)
        if img_prompt is not None:
            urls = await _host_images(await _run_image_turn(img_prompt))
            return _chat_object(cid, model, created, "", urls)
        text, images, sources = await _run_turn(key, model, history, delta)
        urls = await _host_images(images)
        resp = _chat_object(cid, model, created, "".join(full), urls)
        if _include_sources(body.get("include_sources")):
            appendix = _source_appendix(sources, _user_text(history))
            if appendix:
                resp["choices"][0]["message"]["content"] += appendix
        return resp


# ---------------------------------------------------------------------------
# Responses API
# ---------------------------------------------------------------------------

@app.post("/v1/responses")
async def responses_api(request: Request):
    await _check_auth(request)
    body = await request.json()
    model = normalize_model(body.get("model"))
    raw_new = await _responses_items(body.get("input", ""))
    if body.get("instructions"):
        raw_new.insert(0, {"role": "system", "parts": [{"type": "text", "text": body["instructions"]}]})
    new_items = [{"role": x["role"], "parts": x["parts"]} for x in raw_new]
    previous = body.get("previous_response_id")
    key = _responses_key(model, new_items, body.get("user"), previous)
    prior = store.get_session(key) if previous else None
    history = list(prior.get("history", [])) if prior else []
    history.extend(new_items)
    rid = new_id("resp_")
    created = int(time.time())
    img_prompt = _image_intent(new_items)
    lock = _client_locks.setdefault(key, asyncio.Lock())
    async with lock:
        if body.get("stream"):
            async def stream():
                seq = 0
                def event(etype, **payload):
                    nonlocal seq
                    seq += 1
                    return _response_event(etype, seq, payload)
                full = []
                sources_out: list = []
                q: asyncio.Queue = asyncio.Queue(128)
                done = asyncio.Event()
                msg_id = new_id("msg_")
                images_out: list[dict] = []
                async def producer():
                    try:
                        if img_prompt is not None:
                            images_out.extend(await _run_image_turn(img_prompt))
                            return
                        async def delta(text, _event):
                            full.append(text)
                            await q.put(text)
                        text, images, sources = await _run_turn(key, model, history, delta)
                        images_out.extend(images)
                        sources_out.extend(sources)
                    except Exception as exc:
                        await q.put({"error": _openai_error(exc)})
                    finally:
                        done.set()
                yield event("response.created", response=_response_object(rid, model, created, "", "in_progress", previous))
                yield event("response.in_progress")
                yield event("response.output_item.added", output_index=0, item={"id": msg_id, "type": "message", "role": "assistant", "status": "in_progress", "content": []})
                yield event("response.content_part.added", item_id=msg_id, output_index=0, content_index=0, part={"type": "output_text", "text": "", "annotations": []})
                task = asyncio.create_task(producer())
                error = None
                while not done.is_set() or not q.empty():
                    try:
                        item = await asyncio.wait_for(q.get(), 0.5)
                    except asyncio.TimeoutError:
                        continue
                    if isinstance(item, dict) and "error" in item:
                        error = item["error"]
                        yield "event: error\ndata: " + json.dumps(error) + "\n\n"
                        break
                    yield event("response.output_text.delta", item_id=msg_id, output_index=0, content_index=0, delta=item, logprobs=[])
                await task
                if error:
                    return
                text = "".join(full)
                urls = await _host_images(images_out)
                display = text + _image_tail(text, urls)
                appendix = ""
                if _include_sources(body.get("include_sources")):
                    appendix = _source_appendix(sources_out, _user_text(new_items))
                wire = display + appendix
                row = store.get_session(key)
                if row:
                    store.update_session(key, row.get("conversation_id"), history + [{"role": "assistant", "parts": [{"type": "text", "text": display}]}])
                yield event("response.output_text.done", item_id=msg_id, output_index=0, content_index=0, text=wire, logprobs=[])
                yield event("response.content_part.done", item_id=msg_id, output_index=0, content_index=0, part={"type": "output_text", "text": wire, "annotations": []})
                yield event("response.output_item.done", output_index=0, item={"id": msg_id, "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": wire, "annotations": []}]})
                final = _response_object(rid, model, created, text, "completed", previous, urls)
                if appendix:
                    final["output"][0]["content"][0]["text"] = wire
                yield event("response.completed", response=final)
                store.register_response(rid, key)
            return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
        full = []
        sources: list = []
        async def delta(text, _event):
            full.append(text)
        if img_prompt is not None:
            images = await _run_image_turn(img_prompt)
            text = ""
        else:
            text, images, sources = await _run_turn(key, model, history, delta)
            text = "".join(full)
        urls = await _host_images(images)
        display = text + _image_tail(text, urls)
        row = store.get_session(key)
        if row:
            store.update_session(key, row.get("conversation_id"), history + [{"role": "assistant", "parts": [{"type": "text", "text": display}]}])
        store.register_response(rid, key)
        resp = _response_object(rid, model, created, text, "completed", previous, urls)
        if _include_sources(body.get("include_sources")):
            appendix = _source_appendix(sources, _user_text(new_items))
            if appendix:
                resp["output"][0]["content"][0]["text"] = display + appendix
        return resp


# ---------------------------------------------------------------------------
# Images API
# ---------------------------------------------------------------------------

@app.post("/v1/images/generations")
async def images_generations(request: Request):
    await _check_auth(request)
    body = await request.json()
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        raise GrokError("prompt is required", code=400, kind="bad_request")
    try:
        n = int(body.get("n") or 1)
    except (TypeError, ValueError):
        n = 1
    n = max(1, min(n, 4))
    imgs = await _run_image_turn(prompt, n=n,
                                 aspect=aspect_ratio(body.get("size") or body.get("aspect_ratio")))
    urls = await _host_images(imgs)
    if not urls:
        raise GrokError("no images were generated", code=502, kind="image_generation_failed")
    return {"created": int(time.time()), "data": [{"url": u} for u in urls]}


# ---------------------------------------------------------------------------
# Files, models, health
# ---------------------------------------------------------------------------

@app.post("/v1/files")
async def files_create(request: Request, file: UploadFile = File(...), purpose: str = Form("assistants")):
    await _check_auth(request)
    data = await file.read()
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise GrokError("file exceeds 20 MiB", code=400, kind="file_too_large")
    return file_store.create(data, file.filename or "upload.bin", file.content_type, purpose)


@app.get("/v1/files")
async def files_list(request: Request):
    await _check_auth(request)
    return {"object": "list", "data": file_store.list(), "has_more": False}


@app.get("/v1/files/{file_id}")
async def files_get(file_id: str, request: Request):
    await _check_auth(request)
    meta = file_store.metadata(file_id)
    if meta is None:
        return JSONResponse(status_code=404, content={"error": {"message": "file not found", "type": "invalid_request_error"}})
    return meta


@app.delete("/v1/files/{file_id}")
async def files_delete(file_id: str, request: Request):
    await _check_auth(request)
    if not file_store.delete(file_id):
        return JSONResponse(status_code=404, content={"error": {"message": "file not found", "type": "invalid_request_error"}})
    return {"id": file_id, "object": "file", "deleted": True}


@app.get("/v1/models")
async def models():
    ids = ["fast", "grok-3-mini-fast", "grok-4.5-fast", "grok-4.5", "expert"]
    return {"object": "list", "data": [{"id": x, "object": "model", "created": 1700000000, "owned_by": "xai"} for x in ids]}


@app.get("/healthz")
async def healthz():
    return {"ok": True, "accounts": pool.count(), "healthy_accounts": sum(a.healthy for a in pool.accounts()), "port": PORT}


@app.get("/")
async def root():
    return {"service": "grok-to-openai", "docs": "/docs", "endpoints": ["/v1/chat/completions", "/v1/responses", "/v1/images/generations", "/v1/files", "/v1/models"]}


# ---------------------------------------------------------------------------
# Errors and entry point
# ---------------------------------------------------------------------------


def _openai_error(exc: Exception) -> dict:
    if isinstance(exc, GrokError):
        return {"message": exc.message, "type": exc.kind, "param": None, "code": exc.kind}
    return {"message": str(exc), "type": "server_error", "param": None, "code": "server_error"}


@app.exception_handler(GrokError)
async def grok_error_handler(request: Request, exc: GrokError):
    return JSONResponse(status_code=exc.code if 400 <= exc.code < 600 else 500, content={"error": _openai_error(exc)})


@app.exception_handler(Exception)
async def generic_error_handler(request: Request, exc: Exception):
    log.exception("unhandled error")
    return JSONResponse(status_code=500, content={"error": _openai_error(exc)})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
