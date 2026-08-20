"""Tests for inline citation resolution (grok:render -> source URL).

Pins the observed gateway contract: output_text deltas carry
`<grok:render card_id=... type="render_inline_citation">` tags while the
source url arrives separately in a `response.grok.output` event as
`output.card_attachment {id, url}` — usually *after* the tag delta, so
deltas with unresolved tags must be held back and flushed on arrival.
Run:  ./.venv/bin/python -m unittest -v tests.test_citations
"""
from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock

from grok_client import GrokTurn, _has_unresolved_citations, _resolve_citations

URL1 = "https://learn.microsoft.com/en-us/archive/technet-wiki/54326.windows-servers-page-file-sizing-considerations"
URL2 = "https://learn.microsoft.com/en-us/archive/blogs/mrsnrub/the-ubiquitous-pagefile"

LINK1 = f"[learn.microsoft.com]({URL1})"
LINK2 = f"[learn.microsoft.com]({URL2})"

TAG1 = ('<grok:render card_id="775147" card_type="citation_card" '
        'type="render_inline_citation"><argument name="citation_id">0'
        '</argument></grok:render>')
TAG2 = ('<grok:render card_id="f453d2" card_type="citation_card" '
        'type="render_inline_citation"><argument name="citation_id">20'
        '</argument></grok:render>')

CARDS = {"775147": URL1, "f453d2": URL2}


class ResolveCitationsTest(unittest.TestCase):
    def test_known_card_becomes_hostname_link(self):
        out = _resolve_citations(f"text{TAG1} more", CARDS)
        self.assertEqual(out, f"text {LINK1} more")

    def test_multiple_tags_resolved_in_order(self):
        out = _resolve_citations(f"{TAG1} and{TAG2}", CARDS)
        self.assertEqual(out, f"{LINK1} and {LINK2}")

    def test_unknown_card_stripped_not_leaked(self):
        out = _resolve_citations(f"a{TAG1}b", {"nope": "https://x.io"})
        self.assertNotIn("grok:render", out)
        self.assertNotIn("https://x.io", out)
        self.assertEqual(out, "ab")

    def test_echoed_opener_before_real_citation_preserves_text(self):
        # F1 regression: quoted/echoed grok:render text before a real
        # citation must not swallow answer text (first-opener-to-first-
        # closer pairing deleted everything up to the real tag's closer)
        echoed = ('<grok:render card_id="000000" card_type="citation_card" '
                  'type="render_inline_citation">')
        text = (f"The tag looks like {echoed} when quoted. "
                f"Real answer text here.{TAG1} rest of answer")
        out = _resolve_citations(text, CARDS)
        self.assertIn("Real answer text here.", out)
        self.assertIn(LINK1, out)
        self.assertNotIn("grok:render", out)
        self.assertEqual(out,
                         f"The tag looks like  when quoted. Real answer text here. "
                         f"{LINK1} rest of answer")

    def test_quoted_complete_tag_then_real_citation(self):
        quoted = ('<grok:render card_id="000000" card_type="citation_card" '
                  'type="render_inline_citation"><argument name="citation_id">9'
                  '</argument></grok:render>')
        out = _resolve_citations(f"Echo {quoted} cite{TAG1} end", CARDS)
        self.assertEqual(out, f"Echo  cite {LINK1} end")

    def test_unclosed_fragment_mid_answer_preserves_following_text(self):
        # F2 regression: the old sweep's greedy [^>]* ate everything after
        # an unclosed fragment up to the next '>' or end of string
        out = _resolve_citations(
            "The answer starts<grok:render card_i and more real text after it.", {})
        self.assertIn("and more real text after it.", out)
        self.assertNotIn("grok", out)

    def test_unclosed_opener_with_gt_preserves_following_text(self):
        out = _resolve_citations(
            'a<grok:render card_id="777" type="x"> still real', {})
        self.assertEqual(out, "a still real")

    def test_newlines_and_tabs_stripped_from_href(self):
        out = _resolve_citations(f"x{TAG1}y", {"775147": "https://x.io/a\nb\tc"})
        self.assertEqual(out, "x [x.io](https://x.io/abc)y")

    def test_brackets_removed_from_ipv6_label(self):
        out = _resolve_citations(f"x{TAG1}y", {"775147": "https://[2001:db8::1]/a"})
        self.assertEqual(out, "x [2001:db8::1](https://[2001:db8::1]/a)y")

    def test_space_before_citation_after_punctuation(self):
        # user-visible shape: grok emits the tag directly after the
        # punctuation; the resolved link must be separated by a space
        out = _resolve_citations(f"**The rule dates to the NT era.**{TAG1}", CARDS)
        self.assertEqual(out, f"**The rule dates to the NT era.** {LINK1}")

    def test_unclosed_opener_with_argument_body_does_not_leak(self):
        # P2 regression: an opener that never gets closed must not leak
        # its <argument> body either
        out = _resolve_citations(
            'a<grok:render card_id="5"><argument name="citation_id">0</argument> z', {})
        self.assertEqual(out, "a z")
        self.assertNotIn("argument", out)

    def test_fragment_cut_after_equals_no_stray_equals(self):
        # P3 regression: a delta-boundary cut right after '=' must not
        # leave a stray '=' in the answer
        out = _resolve_citations('<grok:render card_type= rest of answer', {})
        self.assertEqual(out, "rest of answer")

    def test_nested_glued_pair_single_separator(self):
        # P3 regression: a nested citation glued to its enclosing tag must
        # keep exactly one leading separator, not two
        inner = ('<grok:render card_id="f453d2" card_type="citation_card" '
                 'type="render_inline_citation">y</grok:render>')
        outer = ('<grok:render card_id="unk" card_type="citation_card">'
                 f"{inner}</grok:render>")
        out = _resolve_citations(outer, CARDS)
        self.assertEqual(out, f" {LINK2}")
        self.assertNotIn("  ", out)

    def test_self_closing_tag(self):
        tag = '<grok:render card_id="775147" card_type="citation_card" type="render_inline_citation"/>'
        out = _resolve_citations(f"x{tag}y", CARDS)
        self.assertEqual(out, f"x {LINK1}y")

    def test_tag_without_card_id_stripped(self):
        tag = '<grok:render card_type="citation_card" type="render_inline_citation">' \
              '<argument name="citation_id">1</argument></grok:render>'
        out = _resolve_citations(f"a{tag}b", CARDS)
        self.assertEqual(out, "ab")

    def test_newlines_inside_tag_still_resolved(self):
        tag = '<grok:render card_id="775147" card_type="citation_card"\n' \
              ' type="render_inline_citation"><argument name="citation_id">0' \
              '</argument>\n</grok:render>'
        out = _resolve_citations(f"x{tag}y", CARDS)
        self.assertEqual(out, f"x {LINK1}y")

    def test_plain_text_unchanged(self):
        text = "no citations here\n\n- bullet"
        self.assertEqual(_resolve_citations(text, CARDS), text)

    def test_empty_cards_strips_everything(self):
        out = _resolve_citations(f"a{TAG1}b", {})
        self.assertEqual(out, "ab")

    def test_url_without_host_falls_back_to_url_label(self):
        out = _resolve_citations(f"x{TAG1}y", {"775147": "https://example.com/post"})
        self.assertEqual(out, "x [example.com](https://example.com/post)y")

    def test_parens_and_spaces_escaped_in_href(self):
        # both parens are escaped so the destination is paren-free and
        # balanced-paren markdown parsers accept the link
        url = "https://x.io/(v=technet.10) a"
        out = _resolve_citations(f"x{TAG1}y", {"775147": url})
        self.assertEqual(out, "x [x.io](https://x.io/%28v=technet.10%29%20a)y")

    def test_reported_archive_paren_url_renders_balanced(self):
        # regression: gateway url with raw parens previously produced an
        # unbalanced destination (v=technet.10%29 that renders as raw text
        url = ("https://learn.microsoft.com/en-us/previous-versions/windows/"
               "it-pro/windows-2000-server/cc938592(v=technet.10)")
        out = _resolve_citations(f"x{TAG1}y", {"775147": url})
        self.assertEqual(
            out,
            "x [learn.microsoft.com]"
            "(https://learn.microsoft.com/en-us/previous-versions/windows/"
            "it-pro/windows-2000-server/cc938592%28v=technet.10%29)y")
        self.assertNotIn("(v=technet", out)

    def test_unresolved_detector(self):
        self.assertFalse(_has_unresolved_citations("plain text", CARDS))
        self.assertTrue(_has_unresolved_citations(f"x{TAG1}", {}))
        self.assertFalse(_has_unresolved_citations(f"x{TAG1}", CARDS))
        # second tag unknown keeps the text unresolved
        self.assertTrue(_has_unresolved_citations(f"{TAG1}{TAG2}", {"775147": URL1}))

    def test_orphan_closer_swept(self):
        self.assertEqual(_resolve_citations("a</grok:render>b", CARDS), "ab")

    def test_orphan_closer_counts_as_resolved(self):
        # a lone closer can never resolve; flushing lets the sweep remove it
        self.assertFalse(_has_unresolved_citations("a</grok:render>b", {}))

    def test_unclosed_opener_swept(self):
        self.assertEqual(_resolve_citations("a<grok:render card_i", CARDS), "a")

    def test_tag_split_mid_attribute_counts_unresolved(self):
        self.assertTrue(_has_unresolved_citations('<grok:render card_id="775147" card_t', CARDS))

    def test_unclosed_opener_after_resolved_tag_counts_unresolved(self):
        self.assertTrue(_has_unresolved_citations(f"{TAG1}<grok:render card_i", CARDS))

    def test_many_unclosed_openers_stripped_without_leak(self):
        text = "echo" + '<grok:render card_id="x"' * 2000
        out = _resolve_citations(text, CARDS)
        self.assertEqual(out, "echo")
        self.assertNotIn("grok", out)

    def test_truncated_opener_does_not_leak_tail_attributes(self):
        # P2-1 regression: the sweep must consume every attribute-shaped
        # token of a truncated opener, not just the first
        out = _resolve_citations(
            '<grok:render card_id="c" card_type="citation_card"', {})
        self.assertEqual(out, "")
        self.assertNotIn("grok", out)
        self.assertNotIn("card_type", out)

    def test_fragment_sweep_preserves_plain_words(self):
        # P2-1 regression: ordinary words after an unclosed fragment are
        # not consumed as if they were attribute tokens
        out = _resolve_citations(
            "The tag <grok:render and more real text after it.", {})
        self.assertEqual(out, "The tag and more real text after it.")
        self.assertNotIn("grok", out)

    def test_hostname_label_strips_userinfo_and_port(self):
        # P2-2 regression: label is the bare hostname, not the netloc
        out = _resolve_citations(
            f"x{TAG1}y", {"775147": "https://user:pass@x.io:8443/a"})
        self.assertEqual(out, "x [x.io](https://user:pass@x.io:8443/a)y")

    def test_nested_pairs_both_emitted(self):
        # P2-3 regression: an outer pair spanning an inner pair must not
        # silently swallow the inner citation
        nested = ('<grok:render card_id="775147" card_type="citation_card">'
                  'x <grok:render card_id="f453d2" card_type="citation_card">'
                  'y</grok:render> z</grok:render>')
        out = _resolve_citations(nested, CARDS)
        self.assertEqual(out, f"{LINK1} {LINK2}")


def make_turn(events: list[dict]) -> GrokTurn:
    turn = GrokTurn(None, None, asyncio.Lock(), model="fast")
    msgs = [{"event": ev} for ev in events]
    turn._recv = AsyncMock(side_effect=msgs)
    turn._send_event = AsyncMock()
    return turn


async def run_generate(turn: GrokTurn, hard_timeout: float = 600.0):
    calls: list[str] = []

    async def on_delta(text, _event):
        calls.append(text)

    text, images, sources = await turn.generate(on_delta, hard_timeout=hard_timeout)
    return text, calls


class DeltaBufferingTest(unittest.IsolatedAsyncioTestCase):
    async def test_tag_before_attachment_held_then_resolved(self):
        # observed live order: tag delta, ... , card_attachment, final text
        events = [
            {"type": "response.output_text.delta", "delta": "It was a simple default.**"},
            {"type": "response.output_text.delta", "delta": TAG1},
            {"type": "response.output_text.delta", "delta": " [cont]."},
            {"type": "response.grok.output", "output": {"card_attachment": {
                "id": "775147", "type": "render_inline_citation",
                "cardType": "citation_card", "url": URL1}}},
            {"type": "response.output_text.done", "text": f"It was a simple default.**{TAG1} [cont]."},
            {"type": "response.done"},
        ]
        text, calls = await run_generate(make_turn(events))
        self.assertEqual(text, f"It was a simple default.** {LINK1} [cont].")
        self.assertEqual(calls, ["It was a simple default.**", f" {LINK1} [cont]."])
        self.assertNotIn("grok:render", text)

    async def test_attachment_before_tag_resolves_immediately(self):
        events = [
            {"type": "response.grok.output", "output": {"card_attachment": {
                "id": "775147", "type": "render_inline_citation",
                "cardType": "citation_card", "url": URL1}}},
            {"type": "response.output_text.delta", "delta": f"see{TAG1}"},
            {"type": "response.output_text.done", "text": f"see{TAG1}"},
            {"type": "response.done"},
        ]
        text, calls = await run_generate(make_turn(events))
        self.assertEqual(text, f"see {LINK1}")
        self.assertEqual(calls, [f"see {LINK1}"])

    async def test_never_resolved_tag_stripped_at_stream_end(self):
        events = [
            {"type": "response.output_text.delta", "delta": "head "},
            {"type": "response.output_text.delta", "delta": TAG1},
            {"type": "response.output_text.delta", "delta": " tail"},
            {"type": "response.output_text.done", "text": f"head {TAG1} tail"},
            {"type": "response.done"},
        ]
        text, calls = await run_generate(make_turn(events))
        # tag removed entirely; surrounding spaces remain ("head <tag> tail")
        self.assertEqual(text, "head  tail")
        self.assertNotIn("grok:render", text)
        self.assertNotIn("grok:render", "".join(calls))

    async def test_plain_stream_unchanged_and_immediate(self):
        events = [
            {"type": "response.output_text.delta", "delta": "one"},
            {"type": "response.output_text.delta", "delta": " two"},
            {"type": "response.output_text.done", "text": "one two"},
            {"type": "response.done"},
        ]
        text, calls = await run_generate(make_turn(events))
        self.assertEqual(text, "one two")
        self.assertEqual(calls, ["one", " two"])

    async def test_thinking_deltas_still_dropped(self):
        events = [
            {"type": "response.output_text.delta", "delta": "hidden",
             "x_grok": {"is_thinking": True}},
            {"type": "response.output_text.delta", "delta": "answer"},
            {"type": "response.output_text.done", "text": "answer"},
            {"type": "response.done"},
        ]
        text, calls = await run_generate(make_turn(events))
        self.assertEqual(text, "answer")
        self.assertEqual(calls, ["answer"])

    async def test_completed_authoritative_text_replaces(self):
        events = [
            {"type": "response.output_text.delta", "delta": f"a{TAG1}"},
            {"type": "response.grok.output", "output": {"card_attachment": {
                "id": "775147", "type": "render_inline_citation",
                "cardType": "citation_card", "url": URL1}}},
            {"type": "response.completed", "response": {"output": [{
                "type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": f"a{TAG1}b"}]}]}},
            {"type": "response.done"},
        ]
        text, calls = await run_generate(make_turn(events))
        self.assertEqual(text, f"a {LINK1}b")
        self.assertEqual(calls, [f"a {LINK1}"])

    async def test_tag_split_across_deltas_held_then_resolved(self):
        events = [
            {"type": "response.grok.output", "output": {"card_attachment": {
                "id": "775147", "type": "render_inline_citation",
                "cardType": "citation_card", "url": URL1}}},
            {"type": "response.output_text.delta", "delta": "pre"},
            {"type": "response.output_text.delta", "delta": '<grok:render card_id="775147" card_t'},
            {"type": "response.output_text.delta",
             "delta": 'ype="citation_card" type="render_inline_citation">'
                      '<argument name="citation_id">0</argument></grok:render> tail'},
            {"type": "response.output_text.done",
             "text": f"pre{TAG1} tail"},
            {"type": "response.done"},
        ]
        text, calls = await run_generate(make_turn(events))
        self.assertEqual(text, f"pre {LINK1} tail")
        self.assertEqual(calls, ["pre", f" {LINK1} tail"])

    async def test_unclosed_opener_never_leaks(self):
        events = [
            {"type": "response.output_text.delta", "delta": "head "},
            {"type": "response.output_text.delta", "delta": '<grok:render card_id="777"'},
            {"type": "response.output_text.delta", "delta": " tail"},
            {"type": "response.output_text.done",
             "text": 'head <grok:render card_id="777" tail'},
            {"type": "response.done"},
        ]
        text, calls = await run_generate(make_turn(events))
        # the tag-shaped fragment is stripped; following words are real text
        # and are preserved (bounded sweep, never eats past the fragment)
        self.assertEqual(text, "head tail")
        self.assertEqual(calls, ["head ", "tail"])
        self.assertNotIn("grok", text)
        self.assertNotIn("grok", "".join(calls))

    async def test_orphan_closer_never_leaks(self):
        events = [
            {"type": "response.output_text.delta", "delta": "a"},
            {"type": "response.output_text.delta", "delta": "</grok:render>"},
            {"type": "response.output_text.delta", "delta": "b"},
            {"type": "response.output_text.done", "text": "a</grok:render>b"},
            {"type": "response.done"},
        ]
        text, calls = await run_generate(make_turn(events))
        self.assertEqual(text, "ab")
        self.assertEqual(calls, ["a", "b"])

    async def test_attachment_after_output_text_done_resolves(self):
        # P1-1 regression: card_attachment arriving AFTER output_text.done
        # must still resolve the citation in both stream and final text
        events = [
            {"type": "response.output_text.delta", "delta": f"Answer {TAG1}"},
            {"type": "response.output_text.done", "text": f"Answer {TAG1}"},
            {"type": "response.grok.output", "output": {"card_attachment": {
                "id": "775147", "url": URL1}}},
            {"type": "response.done"},
        ]
        text, calls = await run_generate(make_turn(events))
        self.assertEqual(text, f"Answer {LINK1}")
        self.assertIn(LINK1, "".join(calls))
        self.assertNotIn("grok", text)

    async def test_attachment_without_type_field_accepted(self):
        # P1-2 regression: the {id, url} contract must not depend on the
        # render-metadata `type` field
        events = [
            {"type": "response.output_text.delta", "delta": f"a{TAG1}"},
            {"type": "response.grok.output", "output": {"card_attachment": {
                "id": "775147", "url": URL1}}},
            {"type": "response.output_text.done", "text": f"a{TAG1}"},
            {"type": "response.done"},
        ]
        text, calls = await run_generate(make_turn(events))
        self.assertEqual(text, f"a {LINK1}")
        self.assertEqual(calls, [f"a {LINK1}"])

    async def test_hard_timeout_flushes_buffered_tail(self):
        turn = GrokTurn(None, None, asyncio.Lock(), model="fast")
        turn._send_event = AsyncMock()
        counter = {"n": 0}

        def recv_ev():
            counter["n"] += 1
            delta = "head <grok:render card_i" if counter["n"] == 1 else "<grok:render card_i"
            return {"event": {"type": "response.output_text.delta", "delta": delta}}

        turn._recv = AsyncMock(side_effect=recv_ev)
        text, calls = await run_generate(turn, hard_timeout=0.2)
        # buffered partial tags are stripped by the post-loop force flush
        self.assertEqual(text, "head ")
        self.assertEqual(calls, ["head "])
        self.assertNotIn("grok", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)