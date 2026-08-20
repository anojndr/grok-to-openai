"""Tests for the optional "Show Sources" bridge (include_sources).

Pins the perplexity-to-openai-style appendix contract: enabled only via
`include_sources: true` (or GROK_INCLUDE_SOURCES=1), appended after the
answer/image content, with the stored conversation history kept clean.
Run:  ./.venv/bin/python -m unittest -v tests.test_include_sources
"""
from __future__ import annotations

import json
import re
import unittest
from unittest.mock import AsyncMock, patch

import server
from grok_client import GrokTurn

SOURCES = [
    {"url": "https://example.com/news", "title": "Example News"},
    {"url": "https://x.com/agency/status/1", "title": "Agency post"},
]

APPENDIX = (
    "\n\nSources\n"
    "1. [Example News](https://example.com/news) (example.com) "
    "via `latest news philippines`\n"
    "2. [Agency post](https://x.com/agency/status/1) (x.com) "
    "via `latest news philippines`\n"
    "\nSearch Queries\n"
    "1. `latest news philippines`"
)


class FakeRequest:
    """Minimal duck-typed Request for the endpoint handlers."""

    def __init__(self, body):
        self._body = body
        self.headers = {}

    async def json(self):
        return self._body


class FakeStore:
    """Stands in for server.store: no sqlite, no rows."""

    def __init__(self, row=None):
        self.row = row
        self.updated = []

    def get_session(self, key):
        return self.row

    def register_response(self, rid, key):
        pass

    def update_session(self, key, conversation_id, history):
        self.updated.append((key, conversation_id, history))


class SourceAppendixTest(unittest.TestCase):
    def test_full_form(self):
        self.assertEqual(
            server._source_appendix(SOURCES, "latest news philippines"), APPENDIX)

    def test_empty_sources_yields_empty(self):
        self.assertEqual(server._source_appendix([], "q"), "")

    def test_no_query_omits_search_queries_and_via(self):
        out = server._source_appendix(SOURCES, "")
        self.assertNotIn("via `", out)
        self.assertNotIn("Search Queries", out)

    def test_title_falls_back_to_url_without_host_suffix(self):
        out = server._source_appendix([{"url": "https://x.io/a", "title": ""}], "q")
        self.assertIn("1. [https://x.io/a](https://x.io/a)", out)
        self.assertNotIn(") (", out)

    def test_url_parens_and_spaces_escaped(self):
        out = server._source_appendix(
            [{"url": "https://x.io/a b)c", "title": "T"}], "q")
        self.assertIn("https://x.io/a%20b%29c", out)

    def test_query_backticks_sanitized(self):
        out = server._source_appendix(SOURCES[:1], "what's `up`")
        self.assertIn("via `what's 'up'`", out)

    def test_multi_line_query_collapses_without_breaking_spans(self):
        out = server._source_appendix(SOURCES[:1], "latest news\nphilippines\t(2026)")
        expected = (
            "\n\nSources\n"
            "1. [Example News](https://example.com/news) (example.com) "
            "via `latest news philippines (2026)`\n"
            "\nSearch Queries\n"
            "1. `latest news philippines (2026)`"
        )
        self.assertEqual(out, expected)

    def test_title_newlines_collapsed(self):
        out = server._source_appendix(
            [{"url": "https://x.io/a", "title": "line1\nline2"}], "q")
        self.assertIn("[line1 line2](https://x.io/a)", out)

    def test_caps_at_50_entries(self):
        many = [{"url": f"https://x.io/{i}", "title": f"t{i}"} for i in range(60)]
        out = server._source_appendix(many, "q")
        entries = [l for l in out.splitlines() if re.match(r"^\d+\. \[", l)]
        self.assertEqual(len(entries), 50)


class IncludeSourcesFlagTest(unittest.TestCase):
    def test_flag_none_uses_env_default(self):
        with patch("server.INCLUDE_SOURCES", True):
            self.assertTrue(server._include_sources(None))
        with patch("server.INCLUDE_SOURCES", False):
            self.assertFalse(server._include_sources(None))

    def test_flag_overrides_env_default(self):
        with patch("server.INCLUDE_SOURCES", True):
            self.assertFalse(server._include_sources(False))
        with patch("server.INCLUDE_SOURCES", False):
            self.assertTrue(server._include_sources(True))

    def test_string_flags_parse_like_env_values(self):
        for truthy in ("1", "true", "TRUE", "yes", "on", " on "):
            self.assertTrue(server._include_sources(truthy))
        for falsy in ("0", "false", "no", "off", "", "garbage"):
            self.assertFalse(server._include_sources(falsy))


class WebSourcesTest(unittest.TestCase):
    EVENT_SEARCH = {"type": "response.search.result", "result": {
        "search_type": "web_search",
        "web_results": [{"url": "https://a.io/1", "title": "A"}]}}

    EVENT_TOOL = {"type": "response.grok.output", "output": {"tool_result": {
        "web_search_results": [{"url": "https://b.io/2", "title": " B "}]}}}

    EVENT_TOOL_SAME_URL = {"type": "response.grok.output", "output": {
        "tool_result": {"web_search_results": [
            {"url": "https://a.io/1", "title": "A again"}]}}}

    def test_search_result_event_extracts_entries(self):
        self.assertEqual(GrokTurn._web_results(self.EVENT_SEARCH),
                         [{"url": "https://a.io/1", "title": "A"}])

    def test_tool_result_event_extracts_entries(self):
        self.assertEqual(GrokTurn._web_results(self.EVENT_TOOL),
                         [{"url": "https://b.io/2", "title": "B"}])

    def test_title_falls_back_to_url(self):
        ev = {"result": {"web_results": [{"url": "https://d.io/4"}]}}
        self.assertEqual(GrokTurn._web_results(ev),
                         [{"url": "https://d.io/4", "title": "https://d.io/4"}])

    def test_malformed_entries_ignored(self):
        ev = {"result": {"web_results": [
            None, {"url": " "}, {"url": "https://e.io/5", "title": 3}]}}
        self.assertEqual(GrokTurn._web_results(ev),
                         [{"url": "https://e.io/5", "title": "3"}])

    def test_unrelated_event_yields_nothing(self):
        self.assertEqual(GrokTurn._web_results({"type": "response.done"}), [])

    def test_prefers_result_shape_when_both_present(self):
        ev = {"result": {"web_results": [{"url": "https://r.io/1", "title": "R"}]},
              "output": {"tool_result": {"web_search_results": [
                  {"url": "https://t.io/2", "title": "T"}]}}}
        self.assertEqual(GrokTurn._web_results(ev),
                         [{"url": "https://r.io/1", "title": "R"}])

    def test_falls_back_to_output_shape_when_result_shape_empty(self):
        ev = {"result": {"web_results": []},
              "output": {"tool_result": {"web_search_results": [
                  {"url": "https://t.io/2", "title": "T"}]}}}
        self.assertEqual(GrokTurn._web_results(ev),
                         [{"url": "https://t.io/2", "title": "T"}])

    def test_dedupe_across_event_shapes(self):
        turn = object.__new__(GrokTurn)
        sources, seen = [], set()
        turn._collect_sources(self.EVENT_SEARCH, sources, seen)
        turn._collect_sources(self.EVENT_TOOL, sources, seen)
        turn._collect_sources(self.EVENT_TOOL_SAME_URL, sources, seen)
        self.assertEqual(sources, [
            {"url": "https://a.io/1", "title": "A"},
            {"url": "https://b.io/2", "title": "B"},
        ])


async def fake_run_turn(key, model, history, on_delta):
    await on_delta("answer text", {})
    return "answer text", [], SOURCES


class ChatCompletionsAppendixTest(unittest.IsolatedAsyncioTestCase):
    async def test_non_stream_appends_when_requested(self):
        body = {"model": "grok-4.5", "include_sources": True,
                "messages": [{"role": "user", "content": "latest news philippines"}]}
        with (
            patch("server._run_turn", new=AsyncMock(side_effect=fake_run_turn)),
            patch("server._host_images", new=AsyncMock(return_value=[])),
        ):
            resp = await server.chat_completions(FakeRequest(body))
        content = resp["choices"][0]["message"]["content"]
        self.assertEqual(content, "answer text" + APPENDIX)

    async def test_non_stream_omits_by_default(self):
        body = {"model": "grok-4.5",
                "messages": [{"role": "user", "content": "latest news philippines"}]}
        with (
            patch("server._run_turn", new=AsyncMock(side_effect=fake_run_turn)),
            patch("server._host_images", new=AsyncMock(return_value=[])),
        ):
            resp = await server.chat_completions(FakeRequest(body))
        self.assertEqual(resp["choices"][0]["message"]["content"], "answer text")

    async def test_non_stream_env_flag_enables_without_body_field(self):
        body = {"model": "grok-4.5",
                "messages": [{"role": "user", "content": "latest news philippines"}]}
        with (
            patch("server.INCLUDE_SOURCES", True),
            patch("server._run_turn", new=AsyncMock(side_effect=fake_run_turn)),
            patch("server._host_images", new=AsyncMock(return_value=[])),
        ):
            resp = await server.chat_completions(FakeRequest(body))
        self.assertEqual(resp["choices"][0]["message"]["content"],
                         "answer text" + APPENDIX)

    async def test_non_stream_appendix_follows_image_tail(self):
        body = {"model": "grok-4.5", "include_sources": True,
                "messages": [{"role": "user", "content": "latest news philippines"}]}
        async def run_turn_with_images(key, model, history, on_delta):
            await on_delta("answer text", {})
            return "answer text", [{"url": "https://pv.test/img.png"}], SOURCES
        with (
            patch("server._run_turn", new=AsyncMock(side_effect=run_turn_with_images)),
            patch("server._host_images",
                  new=AsyncMock(return_value=["https://pv.test/img.png"])),
        ):
            resp = await server.chat_completions(FakeRequest(body))
        content = resp["choices"][0]["message"]["content"]
        self.assertTrue(content.startswith("answer text"))
        self.assertLess(content.index("![image](https://pv.test/img.png)"),
                        content.index("\n\nSources\n1. ["))
        self.assertTrue(content.endswith(APPENDIX))

    async def test_stream_appends_final_chunk(self):
        body = {"model": "grok-4.5", "stream": True, "include_sources": True,
                "messages": [{"role": "user", "content": "latest news philippines"}]}
        with (
            patch("server._run_turn", new=AsyncMock(side_effect=fake_run_turn)),
            patch("server._host_images", new=AsyncMock(return_value=[])),
        ):
            resp = await server.chat_completions(FakeRequest(body))
            chunks = [c async for c in resp.body_iterator]
        contents = []
        for chunk in chunks:
            line = chunk.strip()
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            payload = json.loads(line[len("data: "):])
            if payload.get("object") != "chat.completion.chunk":
                continue
            contents.append(payload["choices"][0]["delta"].get("content", ""))
        self.assertEqual("".join(contents), "answer text" + APPENDIX)


class ResponsesAppendixTest(unittest.IsolatedAsyncioTestCase):
    INPUT = [{"role": "user", "content": [
        {"type": "input_text", "text": "latest news philippines"}]}]

    async def test_non_stream_appends_when_requested(self):
        body = {"model": "grok-4.5", "include_sources": True, "input": self.INPUT}
        store = FakeStore(row={"conversation_id": "conv-1", "history": []})
        with (
            patch("server._run_turn", new=AsyncMock(side_effect=fake_run_turn)),
            patch("server._host_images", new=AsyncMock(return_value=[])),
            patch("server.store", store),
        ):
            resp = await server.responses_api(FakeRequest(body))
        self.assertEqual(resp["output"][0]["content"][0]["text"],
                         "answer text" + APPENDIX)
        # follow-up history keeps the clean answer: no appendix
        stored = store.updated[-1][2][-1]
        self.assertEqual(stored["parts"][0]["text"], "answer text")

    async def test_non_stream_omits_by_default(self):
        body = {"model": "grok-4.5", "input": self.INPUT}
        with (
            patch("server._run_turn", new=AsyncMock(side_effect=fake_run_turn)),
            patch("server._host_images", new=AsyncMock(return_value=[])),
            patch("server.store", FakeStore()),
        ):
            resp = await server.responses_api(FakeRequest(body))
        self.assertEqual(resp["output"][0]["content"][0]["text"], "answer text")

    async def test_stream_appends_to_done_and_completed(self):
        body = {"model": "grok-4.5", "stream": True, "include_sources": True,
                "input": self.INPUT}
        with (
            patch("server._run_turn", new=AsyncMock(side_effect=fake_run_turn)),
            patch("server._host_images", new=AsyncMock(return_value=[])),
            patch("server.store", FakeStore()),
        ):
            resp = await server.responses_api(FakeRequest(body))
            events = {}
            for chunk in [c async for c in resp.body_iterator]:
                for block in chunk.split("\n\n"):
                    data = None
                    for line in block.splitlines():
                        if line.startswith("data: "):
                            data = line[len("data: "):]
                    if data is None or '"type"' not in data:
                        continue
                    payload = json.loads(data)
                    events.setdefault(payload["type"], []).append(payload)
        deltas = "".join(
            p["delta"] for p in events["response.output_text.delta"])
        done = events["response.output_item.done"][0]
        completed = events["response.completed"][0]
        self.assertEqual(deltas, "answer text")
        self.assertEqual(done["item"]["content"][0]["text"],
                         "answer text" + APPENDIX)
        self.assertEqual(completed["response"]["output"][0]["content"][0]["text"],
                         "answer text" + APPENDIX)


if __name__ == "__main__":
    unittest.main(verbosity=2)