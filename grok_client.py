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
import re
import time
import uuid
from typing import Awaitable, Callable
from urllib.parse import urlparse

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


# ---------------------------------------------------------------------------
# Citation resolution
# ---------------------------------------------------------------------------
# Grok's chat gateway emits inline citations as grok:render tags inside the
# output text (e.g. `<grok:render card_id="b086be" card_type="citation_card"
# type="render_inline_citation"><argument name="citation_id">5</argument>
# </grok:render>`); the source url for each card arrives separately in a
# response.grok.output event as output.card_attachment {id, url} matching
# the tag's card_id. The web app renders those tags client-side; raw tags
# must not leak into OpenAI-API output.

TAG_TOKEN_RE = re.compile(
    r"(<grok:render\b[^>]*?/>)|(<grok:render\b[^>]*>)|(</grok:render>)")
CARD_ID_RE = re.compile(r'\bcard_id="([^"]+)"')
# Bounded strip for markup the token pass cannot consume: fragments without
# a closing '>' (e.g. a tag split mid-attribute by a delta boundary) and
# orphan closers. Consumes only attribute-shaped tokens (name="value",
# name=value, or identifier-like names containing _ - : or digits), so a
# truncated opener cannot leak its trailing attributes and ordinary words
# after an unclosed fragment are preserved.
FRAG_TAG_RE = re.compile(
    r"</?grok:render\b"
    r"(?:\s+(?:[\w:.-]+=(?:\"[^\"]*\"|[^<>\s]+)|[\w:-]*[-_:\d][\w:-]*=?))*"
    r"\s*>?")
# The <argument> body grok puts inside a citation tag, used to extend the
# deletion span of an opener that never gets closed. `[^<]*` is bounded by
# the first '<' (linear; no cross-tag scanning) and the body is short.
ARG_BODY_RE = re.compile(r"<argument\b[^>]*>[^<]*</argument>")


def _source_link(url: str) -> str:
    """Markdown link for a resolved citation url, hostname as the label.

    Same sanitization as the bridge source appendix: whitespace is
    stripped, and '(', ')', and spaces are percent-escaped. Gateway urls
    contain raw parens (e.g. `cc938592(v=technet.10)`); escaping both keeps
    the destination paren-free so balanced-paren markdown parsers accept the
    link instead of rendering the raw `[label](url)` text. The label is the
    bare hostname (no userinfo, port, or IPv6 brackets); '['/']' are removed
    defensively so bracket literals cannot terminate the link text early.
    """
    href = (url.strip().replace("\n", "").replace("\r", "").replace("\t", "")
            .replace("(", "%28").replace(")", "%29").replace(" ", "%20"))
    host = urlparse(url).hostname
    label = (host if host else url).replace("[", "").replace("]", "")
    return f"[{label}]({href})"


def _citation_link(text: str, start: int, url: str) -> str:
    """Return a citation link with exactly one preceding separator."""
    separator = " " if start and not text[start - 1].isspace() else ""
    return separator + _source_link(url)


def _card_url(opener: str, card_urls: dict[str, str]) -> str:
    card = CARD_ID_RE.search(opener)
    if card is None:
        return ""
    return card_urls.get(card.group(1), "")


def _resolve_citations(text: str, card_urls: dict[str, str]) -> str:
    """Replace grok:render citation tags with their source links.

    Pairing is left-to-right: each closer closes the most recent opener
    (nearest-closer), so echoed/quoted grok:render text before a real
    citation cannot swallow answer text; each pair becomes the source link
    for its own card_id. Self-closing openers resolve immediately; bare
    openers never closed are deleted without touching the text between.
    Leftover fragments (no '>') and orphan closers are stripped with a
    bounded sweep. Single linear pass.
    """
    if "<grok:render" not in text and "</grok:render" not in text:
        return text
    ops: list[tuple[int, int, str]] = []  # (start, end, replacement)
    stack: list[tuple[int, str]] = []     # (start, opener text)
    for m in TAG_TOKEN_RE.finditer(text):
        if m.group(3):  # closer
            if stack:
                start, opener = stack.pop()
                url = _card_url(opener, card_urls)
                ops.append((start, m.end(), _citation_link(text, start, url) if url else ""))
        elif m.group(1):  # self-closing opener
            url = _card_url(m.group(1), card_urls)
            ops.append((m.start(), m.end(), _citation_link(text, m.start(), url) if url else ""))
        else:  # regular opener
            stack.append((m.start(), m.group(2)))
    for start, opener in stack:
        # an opener that never got closed should not leak its <argument>
        # body either (real grok tags always carry one)
        end = start + len(opener)
        body = ARG_BODY_RE.match(text, end)
        if body:
            end = body.end()
        ops.append((start, end, ""))
    ops.sort()
    out: list[str] = []
    pos = 0
    i = 0
    while i < len(ops):
        start, end, repl = ops[i]
        if start < pos:
            i += 1
            continue
        # Collect pairs nested strictly inside this span so their links are
        # preserved: the wider span would otherwise swallow them, silently
        # dropping valid citations (malformed but not impossible input).
        nested: list[str] = []
        j = i + 1
        while j < len(ops) and ops[j][0] < end:
            if ops[j][2]:
                nested.append(ops[j][2])
            j += 1
        out.append(text[pos:start])
        out.append(repl)
        for nrepl in nested:
            # nested links may already carry their own leading separator
            # from _citation_link; this branch adds exactly one
            out.append(" " + nrepl.lstrip())
        pos = end
        i = j
    out.append(text[pos:])
    return FRAG_TAG_RE.sub("", "".join(out))


def _has_unresolved_citations(text: str, card_urls: dict[str, str]) -> bool:
    """True when text contains citation markup that cannot be resolved yet.

    The gateway streams a tag before its card_attachment event, so deltas
    with unresolved tags must be held back until the attachment arrives.
    Incomplete markup (an opener whose card_id or closing tag has not
    streamed yet) also counts as unresolved: flushing it would leak the
    fragment verbatim to the client.
    """
    if "<grok:render" not in text and "</grok:render" not in text:
        return False
    opens = 0
    opener_count = 0
    for m in TAG_TOKEN_RE.finditer(text):
        if m.group(3):  # closer
            if opens:
                opens -= 1
            continue
        opener_count += 1
        card = CARD_ID_RE.search(m.group(1) or m.group(2))
        if card is None or card.group(1) not in card_urls:
            return True
        if not m.group(1):
            opens += 1
    if opens:
        return True
    # any '<grok:render' occurrence that is not a complete opener token
    # (fragment mid-stream) may still complete in the next delta
    return text.count("<grok:render") != opener_count


# ---------------------------------------------------------------------------
# Degraded-turn detection
# ---------------------------------------------------------------------------
# Some accounts' gateways run their web-search tool against placeholder
# queries that have nothing to do with the user's message (observed live:
# "current information and recent sources", "best expert recommendations
# and evidence", "latest updates and authoritative references"), then the
# model summarizes that unrelated content into fluent-looking word salad
# that still parses as a successful 200. The turn is detectable before the
# salad even streams: the tool_usage_card.query arrives before the output
# deltas. A genuine search almost always echoes at least one significant
# token of the user's message, so a query sharing zero tokens is the
# signature of the degraded path.

USER_TOKEN_RE = re.compile(r"[a-z0-9]{4,}")
# Observed placeholder queries from degraded gateways; a single match here
# is enough to fail the turn even when only one search has run.
GENERIC_SEARCH_QUERIES = frozenset({
    "current information and recent sources",
    "best expert recommendations and evidence",
    "latest updates and authoritative references",
})


def _unrelated_queries(queries: list[str], user_text: str) -> bool:
    """True when 2+ distinct tool queries share no token with the user text.

    Single unrelated queries are tolerated (the model legitimately
    paraphrases); two unrelated queries mean the gateway is searching about
    something else entirely. Matches the observed degraded-gateway profile
    where every search is a placeholder. A known placeholder query counts
    on its own. Empty user_text disables the check (nothing to measure
    against).
    """
    if not user_text or not queries:
        return False
    tokens = set(USER_TOKEN_RE.findall(user_text.lower()))
    if not tokens:
        return False
    distinct: list[str] = []
    seen: set[str] = set()
    for q in queries:
        ql = q.lower().strip()
        if not ql or ql in seen:
            continue
        seen.add(ql)
        distinct.append(ql)
    unrelated = [q for q in distinct if not any(t in q for t in tokens)]
    if len(unrelated) >= 2:
        return True
    return len(unrelated) == 1 and unrelated[0] in GENERIC_SEARCH_QUERIES


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
                open_timeout=8,
                close_timeout=2,
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
        self.tool_queries: list[str] = []

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
        # A live gateway answers session.create in well under a second;
        # a connection that stays silent for 10s is effectively dead, and
        # a short deadline keeps account failover fast (the pool races
        # several accounts when failures occur).
        deadline = time.monotonic() + 10
        got_created = False
        ready = False
        while time.monotonic() < deadline:
            msg = await self._recv(timeout=10)
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
        user_text: str = "",
    ) -> tuple[str, list[dict], list[dict]]:
        """Send response.create and stream deltas.

        Returns (full text, image parts, web sources). Image parts are
        output_image content parts collected from streaming events and the
        final response object; the chat gateway is text-only today, but this
        is where inline image output would surface. Web sources are the
        deduplicated {url, title} citation entries grok attaches to
        search-backed answers (response.search.result events and the
        tool_result payload of response.grok.output events). Inline
        grok:render citation tags in the text are replaced with markdown
        links to their source urls (from response.grok.output card_attachment
        events); deltas are held back only while an unreceived attachment
        would be needed.
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
        pending: list[str] = []
        card_urls: dict[str, str] = {}
        # Authoritative full text from output_text.done / response.completed.
        # It is resolved lazily once card attachments are done arriving
        # (response.done or terminal timeout), never force-flushed early.
        authoritative: str = ""
        images: list[dict] = []
        seen_urls: set[str] = set()
        sources: list[dict] = []
        seen_source_urls: set[str] = set()

        async def flush_pending(force: bool = False) -> None:
            """Forward buffered deltas once their citations can be resolved.

            Deltas containing grok:render citation tags are held back until
            the matching card_attachment arrives (the gateway streams the
            tag before the attachment); unresolved tags at stream end are
            stripped so no raw markup leaks into output.
            """
            if not pending:
                return
            joined = "".join(pending)
            if not force and _has_unresolved_citations(joined, card_urls):
                return
            pending.clear()
            resolved = _resolve_citations(joined, card_urls)
            if resolved:
                # A citation opener can be the first item in this flush even
                # when plain text was emitted by the previous flush. Apply
                # the same exactly-one-space rule across that chunk boundary.
                if (resolved.startswith("[") and text_parts and
                        text_parts[-1] and not text_parts[-1][-1].isspace()):
                    resolved = " " + resolved
                text_parts.append(resolved)
                await on_delta(resolved, {})

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
                    pending.append(delta)
                    await flush_pending()
            elif t == "response.output_item.added":
                for part in self._item_parts(ev.get("item")):
                    self._capture_image(part, images, seen_urls)
            elif t == "response.content_part.added":
                self._capture_image(ev.get("part"), images, seen_urls)
            elif t == "response.output_text.done":
                # Authoritative final text. Card_attachment events can still
                # arrive after this event (each citation streams its tag
                # before its url), so the final text is NOT flushed or
                # resolved here; response.done applies it once all
                # attachments are in. Flushing early would strip citations
                # whose urls had not arrived yet.
                final = ev.get("text") or ""
                if final:
                    authoritative = final
            elif t == "response.completed":
                resp = ev.get("response", {})
                full = self._extract_text(resp)
                if full:
                    authoritative = full
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
                if isinstance(output, dict):
                    card = output.get("tool_usage_card")
                    if isinstance(card, dict):
                        wq = card.get("web_search")
                        if isinstance(wq, dict):
                            query = wq.get("query")
                            if isinstance(query, str) and query.strip():
                                query = query.strip()
                                if query not in self.tool_queries:
                                    self.tool_queries.append(query)
                                    if _unrelated_queries(self.tool_queries, user_text):
                                        # The gateway is searching content
                                        # unrelated to the request; the
                                        # generation that follows is salad.
                                        # Fail now, before it streams, so
                                        # failover costs seconds, not minutes.
                                        raise GrokError(
                                            "gateway searched content unrelated to the request "
                                            "(degraded account)",
                                            kind="degraded_response")
                att = output.get("card_attachment") if isinstance(output, dict) else None
                # contract: {id, url} per the protocol note above; `type` is
                # render metadata and must not gate resolution
                if isinstance(att, dict):
                    card_id = att.get("id")
                    url = att.get("url")
                    if isinstance(card_id, str) and card_id and isinstance(url, str) and url:
                        card_urls[card_id] = url
                await flush_pending()
            elif t == "response.done":
                # terminal event: all card attachments have streamed, so
                # unresolved buffered text can finally be resolved forward
                await flush_pending(force=True)
                if authoritative:
                    full = _resolve_citations(authoritative, card_urls)
                    if full:
                        text_parts = [full]
                break
        # The loop can also exit on hard_timeout without response.done;
        # flush anything still buffered so no stream tail is silently lost.
        # NOTE: the degraded-turn guard lives ONLY at the tool_queries append
        # site (response.grok.output -> tool_usage_card), so no event sequence
        # can leave this loop with tool_queries newly qualifying — a check
        # here would be dead code. Every query collected is checked the
        # moment it is appended.
        await flush_pending(force=True)
        if authoritative:
            full = _resolve_citations(authoritative, card_urls)
            if full:
                text_parts = [full]
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

    async def _recv(self, timeout: float | None = None) -> dict | None:
        """Read the next event addressed to THIS session.

        The persistent connection hosts many sessions; events for other
        sessions (stale acks, late echoes) are consumed and skipped.
        `timeout` bounds the whole read including skipped events; None waits
        indefinitely (callers that need a bound wrap this in asyncio.wait_for
        — e.g. generate's idle_timeout — so the streaming path is governed by
        the turn budget, not a per-message one).
        """
        deadline = None if timeout is None else time.monotonic() + timeout
        while deadline is None or time.monotonic() < deadline:
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
        except asyncio.CancelledError:
            # A racing attempt that loses the preflight race is cancelled
            # mid-connect; its socket must be closed, not leaked.
            self._active.discard(conn)
            await conn.close()
            raise
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