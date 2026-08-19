"""Regression tests for the image-attachment pipeline.

Pins the "no image attached" bug: an OpenAI Responses request that
references an uploaded image via {"type": "input_image", "file_id": ...}
silently lost the image before reaching the grok gateway. Also pins that
unknown file_ids fail loudly instead of being forwarded to grok as bogus
attachment ids, and that history folding preserves attached image parts.
Run:  ./.venv/bin/python -m unittest -v tests.test_image_attachment
"""
from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

import server
from grok_client import GrokError

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32

IMAGE_PART = {"type": "input_image", "file_id": "file-cat1", "detail": "auto"}


class FakeStore:
    """Stands in for server.file_store (no filesystem, no network)."""

    def __init__(self, items=()):
        self._items = {fid: (meta, data) for fid, meta, data in items}

    def get(self, file_id):
        return self._items.get(file_id)


class InputImageFileIdTest(unittest.IsolatedAsyncioTestCase):
    async def test_input_image_file_id_becomes_input_file(self):
        items = await server._responses_items(
            [{"role": "user", "content": [
                {"type": "input_text", "text": "what animal is this"},
                IMAGE_PART]}])
        self.assertEqual(items[0]["parts"][1], {
            "type": "input_file", "file_id": "file-cat1", "filename": None,
            "file": {"data": None, "url": None, "filename": None, "mime_type": None}})

    async def test_input_image_with_url_is_untouched(self):
        items = await server._responses_items(
            [{"role": "user", "content": [
                {"type": "input_image", "image_url": "data:image/png;base64,AAAA"}]}])
        self.assertEqual(items[0]["parts"][0],
                         {"type": "image_url", "image_url": "data:image/png;base64,AAAA"})

    async def test_input_image_file_id_keeps_url_fallback(self):
        items = await server._responses_items(
            [{"role": "user", "content": [
                {"type": "input_image", "file_id": "file-cat1",
                 "image_url": "https://example.org/cat.png"}]}])
        part = items[0]["parts"][0]
        self.assertEqual(part["type"], "input_file")
        self.assertEqual(part["file_id"], "file-cat1")
        self.assertEqual(part["file"]["url"], "https://example.org/cat.png")
        self.assertIsNone(part["file"]["data"])

    async def test_input_image_file_id_keeps_data_fallback(self):
        items = await server._responses_items(
            [{"role": "user", "content": [
                {"type": "input_image", "file_id": "file-cat1",
                 "image_data": "data:image/png;base64,AAAA"}]}])
        part = items[0]["parts"][0]
        self.assertEqual(part["file"]["data"], "data:image/png;base64,AAAA")
        self.assertIsNone(part["file"]["url"])

    async def test_stored_image_attaches_end_to_end(self):
        """input_image.file_id -> local store -> grok upload -> input_file."""
        with (
            patch("server.file_store", FakeStore(
                [("file-cat1", {"filename": "cat.png", "mime_type": "image/png"}, PNG)])),
            patch("server.upload_bytes",
                  new=AsyncMock(return_value={"fileMetadataId": "grok-id-1"})) as up,
        ):
            items = await server._responses_items(
                [{"role": "user", "content": [IMAGE_PART]}])
            content = await server._to_grok_content(object(), items[0]["parts"])
        self.assertEqual(content,
                         [{"type": "input_file", "file_id": "grok-id-1", "filename": "cat.png"}])
        up.assert_awaited_once()
        self.assertEqual(up.await_args.args[1], PNG)
        self.assertEqual(up.await_args.args[2], "cat.png")


class FilePartUnknownIdTest(unittest.IsolatedAsyncioTestCase):
    async def test_unknown_file_id_fails_loudly(self):
        with patch("server.file_store", FakeStore()):
            with self.assertRaises(GrokError) as cm:
                await server._file_part(object(), {"type": "input_file", "file_id": "file-ghost"})
        self.assertEqual(cm.exception.kind, "bad_file")
        self.assertIn("file-ghost", cm.exception.message)

    async def test_known_file_is_uploaded(self):
        with (
            patch("server.file_store", FakeStore(
                [("file-cat1", {"filename": "cat.png", "mime_type": "image/png"}, PNG)])),
            patch("server.upload_bytes",
                  new=AsyncMock(return_value={"fileMetadataId": "grok-id-1"})) as up,
        ):
            out = await server._file_part(object(), {"type": "input_file",
                                                     "file_id": "file-cat1"})
        self.assertEqual(out, {"type": "input_file", "file_id": "grok-id-1",
                               "filename": "cat.png"})
        self.assertEqual(up.await_args.args[1], PNG)
        self.assertEqual(up.await_args.args[2], "cat.png")


class PrependTextTest(unittest.TestCase):
    def test_non_text_parts_survive(self):
        item = {"role": "user", "parts": [
            {"type": "text", "text": "old"},
            {"type": "image_url", "image_url": "data:image/png;base64,AAAA"}]}
        out = server._prepend_text(item, "prefix")
        self.assertEqual(out["parts"], [
            {"type": "text", "text": "prefix"},
            {"type": "image_url", "image_url": "data:image/png;base64,AAAA"}])

    def test_input_text_parts_are_consumed_into_prefix(self):
        """input_text parts fold into the prefix; only non-text survives."""
        item = {"role": "user", "parts": [
            {"type": "input_text", "text": "say hi"},
            {"type": "image_url", "image_url": "data:image/png;base64,AAAA"}]}
        out = server._prepend_text(item, "prefix")
        self.assertEqual(out["parts"], [
            {"type": "text", "text": "prefix"},
            {"type": "image_url", "image_url": "data:image/png;base64,AAAA"}])


class ReplayFoldTest(unittest.IsolatedAsyncioTestCase):
    async def _replay_with_fake_content(self, history):
        async def fake_content(account, parts):
            out = []
            for p in parts:
                if p.get("type") in ("text", "input_text"):
                    out.append({"type": "input_text", "text": p.get("text", "")})
                elif p.get("type") == "image_url":
                    out.append({"type": "input_file", "file_id": "grok-img",
                                "filename": "cat.png"})
            return out
        turn = AsyncMock()
        with patch("server._to_grok_content", new=AsyncMock(side_effect=fake_content)):
            return await server._replay(object(), turn, history), turn

    async def test_image_survives_assistant_fold(self):
        history = [
            {"role": "user", "parts": [
                {"type": "text", "text": "first"},
                {"type": "image_url", "image_url": "data:image/png;base64,AAAA"}]},
            {"role": "assistant", "parts": [{"type": "text", "text": "reply"}]},
            {"role": "user", "parts": [
                {"type": "text", "text": "and here is another"},
                {"type": "image_url", "image_url": "data:image/png;base64,BBBB"}]},
        ]
        (file_ids, response_item), turn = await self._replay_with_fake_content(history)
        added = [c.args[0] for c in turn.add_item.await_args_list]
        # the first turn's image must be re-added as a real item, not dropped
        self.assertTrue(any(
            any(p.get("type") == "input_file" and p.get("file_id") == "grok-img"
                for p in item.get("content", []))
            for item in added))
        # the folded last message keeps both text context and image slot
        self.assertEqual(file_ids, ["grok-img", "grok-img"])
        self.assertIsNotNone(response_item)
        self.assertEqual(response_item["type"], "message")
        text = "".join(p.get("text", "") for p in response_item["content"]
                       if p.get("type") == "input_text")
        self.assertIn("Previous assistant response: reply", text)
        self.assertIn("and here is another", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)