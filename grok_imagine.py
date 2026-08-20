"""grok.com Imagine WebSocket client: the dedicated image generation channel.

The chat gateway (wss://grok.com/ws/mgw/) is text-only (measured live:
`output_modalities: ["text"]`; asking for an image returns a stream_error).
grok's web app generates images over a separate endpoint:

    connect  ->  wss://grok.com/ws/imagine/listen  (cookies, Origin, UA)
    send     ->  {"type": "conversation.item.create", "timestamp": <ms>,
                  "item": {"type": "message", "content": [{"type": "reset"}]}}
    send     ->  {"type": "conversation.item.create", "timestamp": <ms>,
                  "item": {"type": "message", "content": [{"type": "input_text",
                  "requestId": "<uuid>", "text": "<prompt>", "properties": {
                  "section_count": 0, "is_kids_mode": false, "enable_nsfw": false,
                  "skip_upsampler": false, "enable_side_by_side": true,
                  "is_initial": false, "aspect_ratio": "1:1", "enable_pro": false}}]}}
    recv     ->  {"type": "json", "current_status": "start_stage"|"completed",
                  "image_id": "<uuid>", "order": n, "width": n, "height": n,
                  "moderated": bool, "r_rated": bool}
                 {"type": "image", "url": "https://assets.grok.com/images/...",
                  "blob": "<base64>", "percentage_complete": n}
                 {"type": "error", "err_msg": "..."}

The shape matches aurora-develop/grok2api's live-validated Go client.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid

import websockets

from grok_client import GrokError, USER_AGENT

log = logging.getLogger("grok.imagine")

IMAGINE_WS_URL = "wss://grok.com/ws/imagine/listen"
_IMAGE_ID_RE = re.compile(r"/images/([a-f0-9\-]+)\.")

# OpenAI-style sizes / grok aspect ratios
ASPECT_RATIOS = {
    "1280x720": "16:9", "16:9": "16:9",
    "720x1280": "9:16", "9:16": "9:16",
    "1792x1024": "3:2", "1536x1024": "3:2", "3:2": "3:2",
    "1024x1792": "2:3", "1024x1536": "2:3", "2:3": "2:3",
    "1024x1024": "1:1", "1:1": "1:1",
}


def aspect_ratio(size_or_ratio: str | None) -> str:
    """Map an OpenAI size ("1024x1024") or a raw ratio ("16:9") to a grok ratio."""
    return ASPECT_RATIOS.get((size_or_ratio or "").strip().lower()) or "1:1"


def _image_id_from_url(url: str) -> str:
    m = _IMAGE_ID_RE.search(url or "")
    return m.group(1) if m else ""


async def generate_images(account, prompt: str, n: int = 1, aspect: str = "1:1",
                          hard_timeout: float = 240.0) -> list[dict]:
    """Generate up to n images for one prompt over the imagine channel.

    Returns [{"url", "width", "height"}, ...] pointing at assets.grok.com.
    Raises GrokError on transport, timeout, safety-block, or empty result.
    """
    extra_headers = {
        "Cookie": account.cookie_header,
        "Origin": "https://grok.com",
        "User-Agent": USER_AGENT,
    }
    try:
        ws = await websockets.connect(
            IMAGINE_WS_URL,
            additional_headers=extra_headers,
            open_timeout=8,
            close_timeout=2,
            ping_interval=20,
            ping_timeout=20,
            max_size=32 * 1024 * 1024,
        )
    except Exception as e:
        raise GrokError(f"imagine websocket connect failed: {e}", kind="connect_failed") from e

    slots: dict[str, dict] = {}
    results: list[dict] = []
    try:
        async def send_msg(payload: dict) -> None:
            await ws.send(json.dumps(payload))

        await send_msg({"type": "conversation.item.create",
                        "timestamp": int(time.time() * 1000),
                        "item": {"type": "message", "content": [{"type": "reset"}]}})
        await send_msg({"type": "conversation.item.create",
                        "timestamp": int(time.time() * 1000),
                        "item": {"type": "message", "content": [{
                            "type": "input_text",
                            "requestId": str(uuid.uuid4()),
                            "text": prompt,
                            "properties": {
                                "section_count": 0,
                                "is_kids_mode": False,
                                "enable_nsfw": False,
                                "skip_upsampler": False,
                                "enable_side_by_side": True,
                                "is_initial": False,
                                "aspect_ratio": aspect,
                                "enable_pro": False,
                            },
                        }]}})
        deadline = time.monotonic() + hard_timeout
        while time.monotonic() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=60)
            except asyncio.TimeoutError:
                raise GrokError("imagine stream went idle", kind="idle_timeout")
            if isinstance(raw, (bytes, bytearray)):
                continue  # binary blob frames carry nothing we need
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            mtype = msg.get("type")
            if mtype == "error":
                raise GrokError(msg.get("err_msg") or "imagine error", kind="imagine_error")
            if mtype == "json":
                status = msg.get("current_status")
                image_id = msg.get("image_id") or msg.get("job_id")
                if not image_id:
                    continue
                if status == "start_stage":
                    slots[image_id] = {
                        "url": None, "done": False,
                        "width": msg.get("width") or 0,
                        "height": msg.get("height") or 0,
                        "moderated": bool(msg.get("moderated") or msg.get("r_rated")),
                    }
                elif status == "completed":
                    slot = slots.get(image_id)
                    if slot and not slot["done"]:
                        slot["done"] = True
                        if not slot["moderated"] and slot["url"]:
                            results.append({"url": slot["url"], "width": slot["width"],
                                            "height": slot["height"]})
                            if len(results) >= n:
                                break
                if slots and all(s["done"] for s in slots.values()):
                    break
            elif mtype == "image":
                url = msg.get("url")
                slot = slots.get(_image_id_from_url(url or ""))
                if slot and not slot["done"] and url:
                    slot["url"] = url
    except websockets.ConnectionClosed as e:
        raise GrokError(f"imagine ws closed: {e.code} {e.reason}", kind="closed") from e
    finally:
        await ws.close()

    if results:
        return results
    if any(s.get("moderated") for s in slots.values()):
        raise GrokError("image generation was blocked by safety filters", kind="moderated")
    raise GrokError("image generation produced no images (account quota?)",
                    kind="empty_response")