"""grok.com WebSocket chat client (reverse-engineered from the web app).

Protocol (verified live against wss://grok.com/ws/mgw/):
    connect  ->  wss://grok.com/ws/mgw/?uid=<x-userid>  (subprotocol "json")
    send     ->  {"session_id": "<uuid>",
                  "event": {"type": "session.create",
                            "session": {"model": "fast",
                                        "conversation_id": null|"<id>"}}}
    send     ->  {"session_id": ..., "event":
                  {"type": "conversation.item.create",
                   "item": {"type": "message", "role": "user",
                            "content": [{"type": "input_text", "text": "..."}]}}}
    send     ->  {"session_id": ..., "event":
                  {"type": "response.create", "response": {"model": "fast"}}}
    recv     ->  session.created / conversation.attached /
                 response.created / response.output_item.added /
                 response.content_part.added / response.output_text.delta /
                 response.output_text.done / response.content_part.done /
                 response.output_item.done / response.completed /
                 response.search.result / response.grok.output /
                 response.done / error

Session semantics (measured):
  * A response's context = the items added to its session since the
    previous response. Prior conversations are continued by creating a
    NEW session attached to the same conversation_id and re-adding the
    history items; re-adding items inside one session duplicates them and
    corrupts generation.
  * The WS connection can host many sessions (one per turn), so a single
    persistent connection per account is kept and sessions are created
    per turn on it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Awaitable, Callable

import websockets

log = logging.getLogger("grok.client")

WS_URL = "wss://grok.com/ws/mgw/?uid={userid}"

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
)

MODEL_ALIASES = {
    "grok-3-mini-fast": "fast",
    "grok-3-mini": "fast",
    "grok-3-fast": "fast",
    "grok-4.5-fast": "fast",
    "grok-4.5": "fast",
    "grok": "fast",
    "fast": "fast",
    "expert": "expert",
    "grok-4.5-expert": "expert",
    "heavy": "heavy",
    "grok-4.5-heavy": "heavy",
}


def normalize_model(model: str | None) -> str:
    if not model:
        return "fast"
    m = str(model).strip()
    return MODEL_ALIASES.get(m, "fast")


class GrokError(Exception):
    def __init__(self, message: str, code: int = 500, kind: str = "grok_error"):
        super().__init__(message)
        self.message = message
        self.code = code
        self.kind = kind


class AccountConnection:
    """Persistent WebSocket connection to grok's WS gateway for one account.

    Sessions (session.create) are created per turn on this connection.
    """

    def __init__(self, account):
        self.account = account
        self._ws = None
        self._lock = asyncio.Lock()

    async def _ensure_ws(self):
        if self._ws is not None:
            state = getattr(self._ws, "state", None)
            if state is not None:
                if state.name == "OPEN":
                    return self._ws
            elif self._ws.open:
                return self._ws
        if not self.account.x_userid:
            raise GrokError("account has no x-userid cookie", kind="bad_account")
        extra_headers = {
            "Cookie": self.account.cookie_header,
            "Origin": "https://grok.com",
            "User-Agent": USER_AGENT,
        }
        uri = WS_URL.format(userid=self.account.x_userid)
        try:
            self._ws = await websockets.connect(
                uri,
                additional_headers=extra_headers,
                subprotocols=["json"],
                open_timeout=30,
                ping_interval=20,
                ping_timeout=20,
                max_size=16 * 1024 * 1024,
            )
        except Exception as e:
            raise GrokError(f"websocket connect failed: {e}", kind="connect_failed") from e
        return self._ws

    async def close(self):
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None

    async def make_session(self, model: str, conversation_id: str | None) -> "GrokTurn":
        """Create a session on this connection; returns a turn handle."""
        async with self._lock:
            ws = await self._ensure_ws()
            turn = GrokTurn(self.account, ws, self._lock, model=model, connection=self)
            try:
                await turn.create(conversation_id, use_attach=True)
            except GrokError as e:
                if e.kind == "conversation_not_found":
                    # Platform can't attach this conversation -> fresh
                    # conversation (context provided by the caller's replay).
                    turn = GrokTurn(self.account, ws, self._lock, model=model, connection=self)
                    await turn.create(None, use_attach=False)
                else:
                    raise
            return turn


class GrokTurn:
    """One chat turn = one session: create -> add items -> generate."""

    def __init__(self, account, ws, lock, model: str = "fast", connection=None):
        self.account = account
        self._ws = ws
        self._lock = lock
        self._connection = connection
        self.model = normalize_model(model)
        self.session_id = str(uuid.uuid4())
        self.conversation_id: str | None = None
        self.conversation_mode: str | None = None

    # ---- lifecycle -----------------------------------------------------

    async def create(self, conversation_id: str | None, use_attach: bool = True) -> None:
        if conversation_id and use_attach:
            # x_grok attach protocol (web app): attempts to load an
            # existing conversation. Fails with conversation_not_found for
            # conversations not loadable by the gateway (verified).
            session = {
                "model": "auto",
                "x_grok": {
                    "protocol_capabilities": ["conversation_attached", "custom_methods_v1"],
                    "conversation_id": conversation_id,
                    "load_existing": True,
                    "needs_history": True,
                },
            }
        else:
            # Plain session.create reliably creates a NEW conversation.
            session = {"model": self.model}
        await self._send_event({"type": "session.create",
                                "event_id": f"evt_init_{uuid.uuid4()}",
                                "session": session})
        deadline = time.monotonic() + 30
        got_created = False
        ready = False
        while time.monotonic() < deadline:
            msg = await self._recv()
            if msg is None:
                raise GrokError("connection closed during session.create", kind="closed")
            ev = msg.get("event", {})
            t = ev.get("type")
            if t == "session.created":
                got_created = True
                echoed = ev.get("session", {}).get("model")
                if echoed and echoed != "auto":
                    self.model = echoed
            elif t == "conversation.attached":
                conv = ev.get("conversation", {})
                self.conversation_id = conv.get("id") or self.conversation_id
                self.conversation_mode = ev.get("mode")
            elif t == "conversation.commands.updated":
                # marks the conversation READY for item sends; items sent
                # earlier are silently dropped by the gateway
                ready = True
            elif t == "error":
                err = ev.get("error", {})
                if err.get("code") == "conversation_not_found" and conversation_id:
                    # Attachment unsupported for this conversation -> recreate
                    # the needed context via a new conversation below.
                    raise GrokError(
                        err.get("message", "conversation not found"),
                        kind="conversation_not_found",
                    )
                raise GrokError(
                    err.get("message", "session.create failed"),
                    kind=err.get("code", "session_error"),
                )
            if got_created and self.conversation_id and ready:
                return
        if not got_created:
            raise GrokError("session.create timed out", kind="timeout")
        if not self.conversation_id:
            raise GrokError("conversation.attached missing", kind="timeout")
        if not ready:
            raise GrokError("conversation not ready (commands.updated missing)", kind="timeout")

    # ---- message flow --------------------------------------------------

    async def add_item(self, item: dict) -> None:
        await self._send_event({"type": "conversation.item.create", "item": item})

    async def generate(
        self,
        on_delta: Callable[[str, dict], Awaitable[None]],
        hard_timeout: float = 600.0,
        idle_timeout: float = 120.0,
        file_attachment_ids: list[str] | None = None,
        item: dict | None = None,
    ) -> tuple[str, list[dict], list[dict]]:
        """Send response.create and stream deltas.

        Returns (full text, image parts, web sources). Image parts are
        output_image content parts collected from streaming events and the
        final response object; the chat gateway is text-only today, but this
        is where inline image output would surface. Web sources are the
        deduplicated {url, title} citation entries grok attaches to
        search-backed answers (response.search.result events and the
        tool_result payload of response.grok.output events).
        """
        response_event = {"type": "response.create",
                          "response": {"model": self.model}}
        if file_attachment_ids:
            # Grok's web client puts file metadata IDs on response.create;
            # the realtime input_file item shape is not sufficient for the
            # normal chat gateway.
            response_event["file_attachment_ids"] = file_attachment_ids
        if item is not None:
            response_event["item"] = item
        await self._send_event(response_event)
        text_parts: list[str] = []
        images: list[dict] = []
        seen_urls: set[str] = set()
        sources: list[dict] = []
        seen_source_urls: set[str] = set()
        deadline = time.monotonic() + hard_timeout
        while time.monotonic() < deadline:
            try:
                msg = await asyncio.wait_for(self._recv(), timeout=idle_timeout)
            except asyncio.TimeoutError:
                raise GrokError("response stream went idle", kind="idle_timeout")
            if msg is None:
                raise GrokError("connection closed mid-response", kind="closed")
            ev = msg.get("event", {})
            t = ev.get("type")
            if t == "error":
                err = ev.get("error", {})
                raise GrokError(err.get("message", "grok error"),
                                kind=err.get("code", "grok_error"))
            if t == "response.output_text.delta":
                delta = ev.get("delta", "") or ""
                if not ev.get("x_grok", {}).get("is_thinking"):
                    text_parts.append(delta)
                    await on_delta(delta, ev)
            elif t == "response.output_item.added":
                for part in self._item_parts(ev.get("item")):
                    self._capture_image(part, images, seen_urls)
            elif t == "response.content_part.added":
                self._capture_image(ev.get("part"), images, seen_urls)
            elif t == "response.completed":
                resp = ev.get("response", {})
                full = self._extract_text(resp)
                if full:
                    text_parts = [full]
                for part in self._item_parts(resp):
                    self._capture_image(part, images, seen_urls)
                # keep draining: response.done marks the true session end
            elif t == "response.search.result":
                self._collect_sources(ev, sources, seen_source_urls)
            elif t == "response.grok.output":
                # x_grok custom event; carries stream errors in-band
                output = ev.get("output")
                err = output.get("stream_error") if isinstance(output, dict) else None
                if isinstance(err, dict) and err.get("message"):
                    raise GrokError(err.get("message"), kind=err.get("kind") or "grok_error")
                self._collect_sources(ev, sources, seen_source_urls)
            elif t == "response.done":
                break
        text = "".join(text_parts)
        if not text and not images:
            raise GrokError("empty response from grok (account likely throttled)",
                            kind="empty_response")
        return text, images, sources

    @staticmethod
    def _item_parts(item_or_response: dict) -> list[dict]:
        """All content parts from a single output item or a response object."""
        items = item_or_response.get("output")
        if items is None:
            items = [item_or_response]
        parts = []
        for item in items or []:
            for part in item.get("content", []) or []:
                parts.append(part)
        return parts

    @staticmethod
    def _capture_image(part: dict, images: list[dict], seen: set[str]) -> None:
        if not isinstance(part, dict):
            return
        if part.get("type") not in ("output_image", "image"):
            return
        url = part.get("url") or part.get("image_url") or part.get("file_url") or ""
        if isinstance(url, dict):
            url = url.get("url") or ""
        if not isinstance(url, str) or not url or url in seen:
            return
        seen.add(url)
        images.append({"url": url,
                       "mime_type": part.get("mime_type") or part.get("content_type")})

    @staticmethod
    def _extract_text(response_obj: dict) -> str:
        out = []
        for item in response_obj.get("output", []) or []:
            for part in item.get("content", []) or []:
                if part.get("type") == "output_text":
                    out.append(part.get("text") or "")
        return "".join(out)

    @staticmethod
    def _web_results(event: dict) -> list[dict]:
        """Normalize citation entries ({url, title}) out of a gateway event.

        Two shapes carry grok's web citations (verified live):
          response.search.result -> result.web_results[]
          response.grok.output  -> output.tool_result.web_search_results[]
        Prefers the search.result shape when both are present.
        """
        candidates = []
        result = event.get("result")
        if isinstance(result, dict):
            candidates.append(result.get("web_results"))
        output = event.get("output")
        if isinstance(output, dict):
            tool = output.get("tool_result")
            if isinstance(tool, dict):
                candidates.append(tool.get("web_search_results"))
        raw = next((c for c in candidates if c), None)
        if not isinstance(raw, list):
            return []
        out = []
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            url = str(entry.get("url") or "").strip()
            if not url:
                continue
            title = str(entry.get("title") or "").strip() or url
            out.append({"url": url, "title": title})
        return out

    def _collect_sources(self, event: dict, sources: list[dict], seen: set[str]) -> None:
        """Append unique web citations from one event (first-seen order)."""
        for src in self._web_results(event):
            key = src["url"].lower()
            if key in seen:
                continue
            seen.add(key)
            sources.append(src)

    # ---- internals -----------------------------------------------------

    async def _send_event(self, event: dict) -> None:
        payload = json.dumps({"session_id": self.session_id, "event": event})
        try:
            await self._ws.send(payload)
        except Exception as e:
            raise GrokError(f"ws send failed: {e}", kind="send_failed") from e

    async def _recv(self) -> dict | None:
        """Read the next event addressed to THIS session.

        The persistent connection hosts many sessions; events for other
        sessions (stale acks, late echoes) are consumed and skipped.
        """
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                raw = await self._ws.recv()
            except websockets.ConnectionClosed as e:
                raise GrokError(f"ws closed: {e.code} {e.reason}", kind="closed") from e
            except Exception as e:
                raise GrokError(f"ws recv failed: {e}", kind="recv_failed") from e
            if raw is None:
                return None
            try:
                if isinstance(raw, (bytes, bytearray)):
                    raw = raw.decode("utf-8", errors="replace")
                msg = json.loads(raw)
            except json.JSONDecodeError:
                return {"event": {"type": "__raw__", "raw": str(raw)[:500]}}
            sid = msg.get("session_id")
            if sid is None or sid == self.session_id:
                return msg
            # belongs to another session — skip it
        raise GrokError("timed out waiting for session events", kind="timeout")


class GrokSessionManager:
    """Creates an isolated websocket for each turn.

    The gateway's session protocol emits late lifecycle events and silently
    drops items when a prior session is still draining. Isolating turns is
    more reliable than multiplexing; the account pool still load-balances
    concurrent requests. This connection is closed immediately after the
    response completes.
    """

    def __init__(self):
        self._active: set[AccountConnection] = set()

    async def new_turn(self, account, model: str,
                       conversation_id: str | None) -> GrokTurn:
        conn = AccountConnection(account)
        self._active.add(conn)
        try:
            # The gateway's load_existing attach path is not stable for
            # conversations created through this client. Reconstructing the
            # prior turns as separate conversation items is reliable and
            # preserves multi-turn semantics without one giant prompt.
            return await conn.make_session(model, None)
        except Exception:
            self._active.discard(conn)
            await conn.close()
            raise

    async def close_turn(self, turn: GrokTurn | None) -> None:
        if turn is None:
            return
        conn = getattr(turn, "_connection", None)
        if conn is not None:
            self._active.discard(conn)
            await conn.close()

    async def close_all(self) -> None:
        conns = list(self._active)
        self._active.clear()
        for c in conns:
            await c.close()