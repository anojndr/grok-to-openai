"""Tests for the dedicated image-generation websocket protocol."""
from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

from grok_client import GrokError
from grok_imagine import generate_images


class FakeWebSocket:
    def __init__(self, messages):
        self.messages = list(messages)
        self.closed = False

    async def send(self, payload):
        pass

    async def recv(self):
        if not self.messages:
            # Scripted frames exhausted: simulate a silent peer. Tests rely
            # on generate_images breaking out (collected result or expired
            # grace) rather than waiting out this sleep.
            await asyncio.sleep(3600)
        return self.messages.pop(0)

    async def close(self):
        self.closed = True


class FakeAccount:
    cookie_header = "sso=test"


class ImagineFrameOrderTests(unittest.IsolatedAsyncioTestCase):
    async def test_image_after_completed_is_collected(self):
        image_id = "01234567-89ab-cdef-0123-456789abcdef"
        url = f"https://assets.grok.com/images/{image_id}.png"
        ws = FakeWebSocket([
            json.dumps({"type": "json", "current_status": "start_stage",
                        "image_id": image_id, "width": 1024, "height": 1024}),
            json.dumps({"type": "json", "current_status": "completed",
                        "image_id": image_id}),
            json.dumps({"type": "image", "url": url}),
        ])
        with patch("grok_imagine.websockets.connect", new=AsyncMock(return_value=ws)):
            images = await generate_images(FakeAccount(), "a cat", n=1)
        self.assertEqual(images, [{"url": url, "width": 1024, "height": 1024}])
        self.assertTrue(ws.closed)

    async def test_completed_without_image_frame_still_fails_after_grace(self):
        image_id = "01234567-89ab-cdef-0123-456789abcdef"
        ws = FakeWebSocket([
            json.dumps({"type": "json", "current_status": "start_stage",
                        "image_id": image_id}),
            json.dumps({"type": "json", "current_status": "completed",
                        "image_id": image_id}),
        ])
        with patch("grok_imagine.COMPLETION_GRACE_SECONDS", 0.01), \
             patch("grok_imagine.websockets.connect", new=AsyncMock(return_value=ws)):
            with self.assertRaises(GrokError) as ctx:
                await generate_images(FakeAccount(), "a cat", n=1)
        self.assertEqual(ctx.exception.kind, "empty_response")
        self.assertTrue(ws.closed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
