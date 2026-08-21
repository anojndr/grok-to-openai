"""Tests for fast account failover.

Pins the racing contract: when accounts fail, session setup for several
accounts runs concurrently and only the first account whose session becomes
ready carries the turn — wall time follows the fastest working account, not
the sum of every failing account's timeout. Also pins the pool/account book
keeping (in_flight release, failure reporting) so racing never leaks load or
marks a healthy account that merely lost the race as failed.
Run:  ./.venv/bin/python -m unittest -v tests.test_fast_failover
"""
from __future__ import annotations

import asyncio
import json
import time
import unittest
from unittest.mock import patch

import server
from accounts import Account, AccountPool
import grok_client
from grok_client import GrokError, GrokTurn

TEXT = "hello from grok"
HISTORY = [{"role": "user", "parts": [{"type": "text", "text": "hi"}]}]

# module-scoped loop: tests share one event loop across run() calls (no
# cross-loop handles are created).
_LOOP = asyncio.new_event_loop()


def make_account(index: int, healthy: bool = True) -> Account:
    acc = Account(index=index, label=f"account-{index + 1}", cookies={}, x_userid="uid")
    acc.healthy = healthy
    return acc


def run(coro):
    return _LOOP.run_until_complete(coro)


class FakeTurn:
    """Duck-typed GrokTurn; records generate and holds no connection."""

    def __init__(self, account, fail=None):
        self.account = account
        self.fail = fail
        self.session_id = f"sess-{account.index}"
        self.conversation_id = f"conv-{account.index}"

    async def add_item(self, item):
        self.items = getattr(self, "items", []) + [item]

    async def generate(self, on_delta, file_attachment_ids=None, item=None, user_text=""):
        if self.fail is not None:
            raise self.fail
        await on_delta(TEXT, {})
        return TEXT, [], []


class FakeManager:
    """new_turn fails or delays per account index; close_turn records."""

    def __init__(self, fail_indices=(), delays=(), turn_fail=None, turn_fail_map=None):
        self.fail_indices = set(fail_indices)
        self.delays = dict(delays)
        self.turn_fail = turn_fail
        self.turn_fail_map = dict(turn_fail_map or {})
        self.created: list[FakeTurn] = []
        self.closed: list[FakeTurn] = []

    async def new_turn(self, account, model, conversation_id):
        if account.index in self.delays:
            await asyncio.sleep(self.delays[account.index])
        if account.index in self.fail_indices:
            raise GrokError(f"preflight failed for {account.index}", kind="connect_failed")
        turn = FakeTurn(account, fail=self.turn_fail_map.get(account.index, self.turn_fail))
        self.created.append(turn)
        return turn

    async def close_turn(self, turn):
        if turn is not None:
            self.closed.append(turn)

    async def close_all(self):
        pass


class FakePool:
    """acquire_many drains a pre-scripted list of account groups."""

    def __init__(self, waves, known=()):
        self.waves = list(waves)
        self.known = list(known)
        self.released: list[Account] = []
        self.failures: list[tuple[Account, str]] = []
        self.successes: list[Account] = []

    async def acquire_many(self, n):
        return self.waves.pop(0) if self.waves else []

    def accounts(self):
        return self.known

    def release(self, acc):
        self.released.append(acc)
        if acc.in_flight > 0:
            acc.in_flight -= 1

    def report_failure(self, acc, reason):
        self.failures.append((acc, reason))

    def report_success(self, acc):
        self.successes.append(acc)


class FakeStore:
    def __init__(self, row=None):
        self.row = row
        self.created: list[tuple] = []
        self.deleted: list[str] = []

    def get_session(self, key):
        return self.row

    def delete_session(self, key):
        self.deleted.append(key)

    def create_session(self, *args):
        self.created.append(args)


async def _deltas(text, _event):
    pass


class RaceAttemptsTests(unittest.TestCase):
    def _run(self, accounts, manager, pool):
        store = FakeStore()
        with patch.object(server, "manager", manager), \
             patch.object(server, "pool", pool), \
             patch.object(server, "store", store):
            return run(server._race_attempts("k", "fast", HISTORY, _deltas, accounts)), store

    def test_fast_account_wins_race(self):
        slow = make_account(0)   # setup is slow, would fail at 50ms
        fast = make_account(1)   # setup succeeds immediately
        manager = FakeManager(fail_indices={0}, delays={0: 0.05})
        pool = FakePool(waves=[])
        (result, error), store = self._run([slow, fast], manager, pool)
        self.assertIsNone(error)
        self.assertEqual(result[0], TEXT)
        self.assertEqual(pool.released.count(slow), 1)
        self.assertEqual(pool.released.count(fast), 1)
        self.assertIn(fast, pool.successes)
        # The loser was cancelled before its failure materialized: it is not
        # accused (no false cooldown), it is merely released.
        self.assertEqual(pool.failures, [])
        # Only the winner's turn was created and closed; a turn never existed
        # for the cancelled loser.
        self.assertEqual([t.account.index for t in manager.created], [1])
        self.assertEqual([t.account.index for t in manager.closed], [1])
        self.assertEqual(store.created[0][1], 1)  # pinned to winner

    def test_all_preflights_fail_reports_and_releases(self):
        accounts = [make_account(0), make_account(1)]
        manager = FakeManager(fail_indices={0, 1})
        pool = FakePool(waves=[])
        (result, error), _store = self._run(accounts, manager, pool)
        self.assertIsNone(result)
        self.assertIsInstance(error, GrokError)
        self.assertEqual(sorted(a.index for a, _ in pool.failures), [0, 1])
        self.assertEqual(pool.released.count(accounts[0]), 1)
        self.assertEqual(pool.released.count(accounts[1]), 1)
        self.assertFalse(pool.successes)

    def test_generate_failure_reports_winner(self):
        acc = make_account(0)
        manager = FakeManager(turn_fail=GrokError("throttled", kind="empty_response"))
        pool = FakePool(waves=[])
        (result, error), store = self._run([acc], manager, pool)
        self.assertIsNone(result)
        self.assertIsInstance(error, GrokError)
        self.assertEqual([a.index for a, _ in pool.failures], [0])
        self.assertEqual(pool.released.count(acc), 1)
        self.assertEqual(len(manager.closed), 1)
        self.assertFalse(store.created)

    def test_success_records_session(self):
        acc = make_account(0)
        manager = FakeManager()
        pool = FakePool(waves=[])
        (result, error), store = self._run([acc], manager, pool)
        self.assertIsNone(error)
        self.assertEqual(result[0], TEXT)
        self.assertEqual(store.created[0][0], "k")
        self.assertEqual(store.created[0][1], 0)
        self.assertEqual(store.created[0][5], HISTORY)


class RunTurnTests(unittest.TestCase):
    def setUp(self):
        self.manager = FakeManager()
        self.store = FakeStore()

    def test_first_attempt_serial_then_race(self):
        a0 = make_account(0)
        a1 = make_account(1)
        a2 = make_account(2)
        a3 = make_account(3)
        # Round 1: one account that fails; round 2: four raced, one works.
        pool = FakePool(waves=[[a0], [a1, a2, a0, a3]], known=[a0, a1, a2, a3])
        manager = FakeManager(fail_indices={0, 1, 2})
        with patch.object(server, "manager", manager), \
             patch.object(server, "pool", pool), \
             patch.object(server, "store", self.store):
            (text, images, sources) = run(server._run_turn("k", "fast", HISTORY, _deltas))
        self.assertEqual(text, TEXT)
        self.assertIn(a3, pool.successes)
        # every acquired slot was returned
        for acc in (a0, a1, a2, a3):
            self.assertEqual(acc.in_flight, 0)
        self.assertIn("k", self.store.deleted)  # failed round cleared the pin

    def test_deterministic_4xx_aborts_without_retry(self):
        a0 = make_account(0)
        pool = FakePool(waves=[[a0], [make_account(1), make_account(2)]])
        manager = FakeManager(turn_fail=GrokError("bad file", code=400, kind="bad_file"))
        with patch.object(server, "manager", manager), \
             patch.object(server, "pool", pool), \
             patch.object(server, "store", self.store):
            with self.assertRaises(GrokError) as ctx:
                run(server._run_turn("k", "fast", HISTORY, _deltas))
        self.assertEqual(ctx.exception.code, 400)
        # Only the first wave was consumed, and the account was NOT
        # penalized: a deterministic client error fails on any account
        # identically, so it must not apply a cooldown to the winner.
        self.assertEqual(len(pool.waves), 1)
        self.assertEqual(pool.failures, [])

    def test_no_accounts_returns_503(self):
        pool = FakePool(waves=[[]])
        with patch.object(server, "manager", self.manager), \
             patch.object(server, "pool", pool), \
             patch.object(server, "store", self.store):
            with self.assertRaises(GrokError) as ctx:
                run(server._run_turn("k", "fast", HISTORY, _deltas))
        self.assertEqual(ctx.exception.code, 503)
        self.assertEqual(ctx.exception.kind, "no_accounts")

    def test_all_accounts_failed_502(self):
        # All six rounds consume accounts that fail; the budget runs out.
        waves = [[make_account(i)] for i in range(6)]
        pool = FakePool(waves=waves)
        manager = FakeManager(fail_indices=set(range(6)))
        with patch.object(server, "manager", manager), \
             patch.object(server, "pool", pool), \
             patch.object(server, "store", self.store):
            with self.assertRaises(GrokError) as ctx:
                run(server._run_turn("k", "fast", HISTORY, _deltas))
        self.assertEqual(ctx.exception.code, 502)
        self.assertEqual(ctx.exception.kind, "all_accounts_failed")

    def test_503_when_pool_empties_mid_request(self):
        # A failed round followed by an exhausted pool is a capacity
        # problem: 503 (retryable), never 502.
        pool = FakePool(waves=[[make_account(0)], [make_account(1)], []])
        manager = FakeManager(fail_indices={0, 1})
        with patch.object(server, "manager", manager), \
             patch.object(server, "pool", pool), \
             patch.object(server, "store", self.store):
            with self.assertRaises(GrokError) as ctx:
                run(server._run_turn("k", "fast", HISTORY, _deltas))
        self.assertEqual(ctx.exception.code, 503)
        self.assertEqual(ctx.exception.kind, "no_accounts")

    def test_pinned_account_is_used_first(self):
        pinned = make_account(5)
        pool = FakePool(waves=[[make_account(1)]], known=[pinned])
        self.store.row = {"account_index": 5, "history": HISTORY}
        with patch.object(server, "manager", self.manager), \
             patch.object(server, "pool", pool), \
             patch.object(server, "store", self.store):
            (text, images, sources) = run(server._run_turn("k", "fast", HISTORY, _deltas))
        self.assertEqual(text, TEXT)
        self.assertEqual([t.account.index for t in self.manager.created], [5])
        self.assertEqual(pool.waves, [[make_account(1)]])  # no fresh acquire
        self.assertEqual(self.store.created[0][1], 5)


class AcquireManyTests(unittest.TestCase):
    def test_distinct_accounts_and_release_guard(self):
        pool = AccountPool()
        pool._accounts = [make_account(0), make_account(1), make_account(2)]
        got = run(pool.acquire_many(5))
        self.assertEqual(sorted(a.index for a in got), [0, 1, 2])
        self.assertEqual(len(got), 3)  # duplicates never returned
        self.assertEqual(len({id(a) for a in got}), 3)
        self.assertTrue(all(a.in_flight == 1 for a in got))

    def test_empty_pool(self):
        pool = AccountPool()
        pool._accounts = []
        self.assertEqual(run(pool.acquire_many(4)), [])

    def test_cooldown_account_excluded(self):
        pool = AccountPool()
        hot = make_account(0)
        cooling = make_account(1)
        cooling.cooldown_until = 10 ** 9
        pool._accounts = [hot, cooling]
        got = run(pool.acquire_many(4))
        self.assertEqual([a.index for a in got], [0])

    def test_skewed_load_still_fills_race(self):
        # Regression: round-robin among the least-loaded group used to
        # re-pick an already-picked account and stop early, under-filling
        # the race even though higher-load accounts were available.
        pool = AccountPool()
        busy = make_account(3)
        busy.in_flight = 5
        pool._accounts = [make_account(0), make_account(1), make_account(2), busy]
        got = run(pool.acquire_many(4))
        self.assertEqual(sorted(a.index for a in got), [0, 1, 2, 3])
        # every slot acquired exactly once: the three idle accounts at load 1,
        # the pre-busy account incremented on top of its existing 5
        self.assertEqual([a.in_flight for a in sorted(got, key=lambda a: a.index)],
                         [1, 1, 1, 6])


class ProbeTests(unittest.TestCase):
    def test_probe_success_marks_healthy(self):
        acc = make_account(0)
        acc.last_probe = 0
        pool = FakePool(waves=[])
        resp = unittest.mock.MagicMock()
        resp.status_code = 200
        resp.json.return_value = {"remainingQueries": 5}
        client = unittest.mock.MagicMock()
        client.post = unittest.mock.AsyncMock(return_value=resp)
        with patch.object(server, "pool", pool):
            run(server._probe_account(acc, client))
        self.assertEqual(acc.remaining_queries, 5)
        self.assertTrue(acc.healthy)
        self.assertIn(acc, pool.successes)

    def test_probe_exhausted_marks_cooldown(self):
        acc = make_account(0)
        pool = FakePool(waves=[])
        resp = unittest.mock.MagicMock()
        resp.status_code = 200
        resp.json.return_value = {"remainingQueries": 0}
        client = unittest.mock.MagicMock()
        client.post = unittest.mock.AsyncMock(return_value=resp)
        with patch.object(server, "pool", pool):
            run(server._probe_account(acc, client))
        self.assertFalse(acc.healthy)
        self.assertGreater(acc.cooldown_until, 0)
        self.assertEqual([a.index for a, _ in pool.failures], [0])


class SameWakeupBatchTests(unittest.TestCase):
    """Regression: asyncio.wait returns the WHOLE batch of tasks completed
    by the time it resumes, not just one. The race must process every task
    in the batch — a second success is closed+released, a failure is
    reported+released — or connections and slots leak (review F1/F2)."""

    def _run(self, accounts, manager, pool):
        store = FakeStore()
        with patch.object(server, "manager", manager), \
             patch.object(server, "pool", pool), \
             patch.object(server, "store", store):
            return run(server._race_attempts("k", "fast", HISTORY, _deltas, accounts)), store

    def test_two_successes_same_wakeup_both_released_one_closed(self):
        # Zero-await preflights complete together in one wait wakeup.
        a0 = make_account(0)
        a1 = make_account(1)
        manager = FakeManager()          # both succeed instantly
        pool = FakePool(waves=[])
        (result, error), store = self._run([a0, a1], manager, pool)
        self.assertIsNone(error)
        self.assertEqual(result[0], TEXT)
        # Both slots released exactly once — the runner-up is not leaked.
        self.assertEqual(len(pool.released), 2)
        self.assertEqual(len({id(a) for a in pool.released}), 2)
        self.assertEqual(pool.released.count(a0), 1)
        self.assertEqual(pool.released.count(a1), 1)
        # Both turns were closed: the winner after generate, the runner-up
        # immediately (its connection must not stay open).
        self.assertEqual(len(manager.closed), 2)
        self.assertEqual(len(pool.successes), 1)
        self.assertEqual(pool.failures, [])

    def test_success_and_failure_same_wakeup_failure_reported(self):
        a_bad = make_account(0)
        a_good = make_account(1)
        manager = FakeManager(fail_indices={0})  # fail + success, no awaits
        pool = FakePool(waves=[])
        (result, error), store = self._run([a_bad, a_good], manager, pool)
        self.assertIsNone(error)
        self.assertEqual(result[0], TEXT)
        # The failed account in the same batch is reported AND released.
        self.assertEqual([a.index for a, _ in pool.failures], [0])
        self.assertEqual(len(pool.released), 2)
        self.assertEqual({id(a) for a in pool.released}, {id(a_bad), id(a_good)})
        self.assertEqual(len(pool.successes), 1)


class RecvTimeoutTests(unittest.TestCase):
    """_recv's budget applies to session setup; the streaming path stays
    governed by generate's idle_timeout, not a per-message deadline."""

    def _turn(self, ws) -> GrokTurn:
        acc = make_account(0)
        return GrokTurn(acc, ws, asyncio.Lock(), model="fast")

    def test_bounded_recv_times_out_fast(self):
        # A stream of other-session events keeps the read going past the
        # budget: _recv's own deadline must fire (a deadline cannot interrupt
        # one blocking recv; real ws.recv always returns or raises, so this
        # flood is the realistic shape of a stuck session).
        ws = unittest.mock.MagicMock()
        ws.recv = unittest.mock.AsyncMock(
            return_value=json.dumps({"session_id": "other", "event": {"type": "stale"}}))
        turn = self._turn(ws)
        start = time.monotonic()
        with self.assertRaises(GrokError) as ctx:
            run(turn._recv(timeout=0.05))
        self.assertEqual(ctx.exception.kind, "timeout")
        self.assertLess(time.monotonic() - start, 5.0)

    def test_unbounded_recv_lets_wait_for_govern(self):
        async def never():
            await asyncio.Event().wait()
        ws = unittest.mock.MagicMock()
        ws.recv = unittest.mock.AsyncMock(side_effect=never)
        turn = self._turn(ws)
        with self.assertRaises(asyncio.TimeoutError):
            run(asyncio.wait_for(turn._recv(), timeout=0.05))

    def test_skips_other_sessions_within_budget(self):
        ws = unittest.mock.MagicMock()
        ws.recv = unittest.mock.AsyncMock(side_effect=[
            json.dumps({"session_id": "other", "event": {"type": "stale"}}),
            json.dumps({"session_id": "mine", "event": {"type": "mine"}}),
        ])
        turn = self._turn(ws)
        turn.session_id = "mine"
        msg = run(turn._recv(timeout=5))
        self.assertEqual(msg["event"]["type"], "mine")


class UnrelatedQueriesTests(unittest.TestCase):
    """_unrelated_queries flags gateways that search content unrelated to
    the user's message (the word-salad failure mode)."""

    GENERIC = "current information and recent sources"
    USER = "what steel thickness can stop a 50 bmg"

    def test_two_unrelated_queries_flag(self):
        # non-generic pair: the >=2 DISTINCT unrelated branch must fire on
        # its own (a single generic template would fire earlier)
        self.assertTrue(grok_client._unrelated_queries(
            ["sports scores for today", "weather forecast tokyo"], self.USER))

    def test_single_unrelated_query_tolerated(self):
        # the model may paraphrase once; one unrelated search is not proof
        self.assertFalse(grok_client._unrelated_queries(
            ["sports scores for today"], self.USER))

    def test_single_generic_template_flags(self):
        self.assertTrue(grok_client._unrelated_queries(
            ["latest updates and authoritative references"], self.USER))

    def test_related_queries_pass(self):
        self.assertFalse(grok_client._unrelated_queries(
            ["steel thickness to stop 50 bmg", "AR500 armor plate specs"],
            self.USER))

    def test_mixed_related_and_one_unrelated_passes(self):
        self.assertFalse(grok_client._unrelated_queries(
            ["steel thickness for 50 bmg", "sports scores for today"], self.USER))

    def test_empty_user_text_disables_check(self):
        self.assertFalse(grok_client._unrelated_queries(
            [self.GENERIC, "best expert recommendations and evidence"], ""))

    def test_duplicate_queries_count_once(self):
        self.assertFalse(grok_client._unrelated_queries(
            ["sports scores for today", "sports scores for today"], self.USER))


class DegradedTurnTests(unittest.TestCase):
    """generate() aborts a turn whose gateway searches content unrelated to
    the user's message instead of delivering the word salad as success."""

    USER = "what steel thickness can stop a 50 bmg"

    def _turn(self, events):
        acc = make_account(0)
        ws = unittest.mock.MagicMock()
        ws.recv = unittest.mock.AsyncMock(side_effect=[
            json.dumps({"session_id": "mine", "event": e}) for e in events
        ])
        turn = GrokTurn(acc, ws, asyncio.Lock(), model="fast")
        turn.session_id = "mine"
        turn._send_event = unittest.mock.AsyncMock()
        return turn

    def _output(self, **output):
        return {"type": "response.grok.output", "output": output}

    def test_early_abort_on_two_unrelated_queries(self):
        # non-generic pair: the first query alone is tolerated (one
        # paraphrase is legal), the second makes the turn degraded
        turn = self._turn([
            {"type": "response.created"},
            self._output(tool_usage_card={"web_search": {"query": "sports scores for today"}}),
            self._output(tool_usage_card={"web_search": {"query": "weather forecast tokyo"}}),
            {"type": "response.output_text.delta", "delta": "garbage "},
        ])
        with self.assertRaises(GrokError) as ctx:
            run(turn.generate(lambda t, e: None, user_text=self.USER))
        self.assertEqual(ctx.exception.kind, "degraded_response")
        # generate must have actually sent response.create before streaming
        send = turn._send_event.await_args.args[0]
        self.assertEqual(send["type"], "response.create")

    def test_related_queries_stream_normally(self):
        deltas = []
        events = [
            {"type": "response.created"},
            self._output(tool_usage_card={"web_search": {"query": "steel thickness to stop 50 bmg"}}),
            {"type": "response.search.result",
             "result": {"search_type": "web_search",
                        "web_results": [{"url": "https://example.com/x", "title": "armor steel specs"}]}},
            {"type": "response.output_text.delta", "delta": "**Around"},
            {"type": "response.output_text.delta", "delta": " 19 mm.**"},
            {"type": "response.done"},
        ]
        turn = self._turn(events)
        async def on_delta(text, _e):
            deltas.append(text)
        text, images, sources = run(turn.generate(on_delta, user_text=self.USER))
        self.assertEqual(text, "**Around 19 mm.**")
        self.assertEqual(sources[0]["url"], "https://example.com/x")

    def test_single_generic_query_aborts(self):
        # the observed degraded gateways search ONLY placeholder queries; a
        # generic template with zero overlap is the signature on its own
        turn = self._turn([
            {"type": "response.created"},
            self._output(tool_usage_card={"web_search": {"query": "current information and recent sources"}}),
            {"type": "response.output_text.delta", "delta": "Paris."},
            {"type": "response.done"},
        ])
        with self.assertRaises(GrokError) as ctx:
            run(turn.generate(lambda t, e: None, user_text=self.USER))
        self.assertEqual(ctx.exception.kind, "degraded_response")


class DegradedFailoverTests(unittest.TestCase):
    """A degraded turn is reported to the pool and retried on another
    account; the account is then quarantined by pick()."""

    def test_degraded_turn_fails_over_to_healthy_account(self):
        a0 = make_account(0)
        a1 = make_account(1)
        pool = FakePool(waves=[[a0], [a1]], known=[a0, a1])
        manager = FakeManager(turn_fail_map={
            0: GrokError("gateway searched content unrelated to the request (degraded account)",
                         kind="degraded_response")})
        store = FakeStore()
        with patch.object(server, "manager", manager), \
             patch.object(server, "pool", pool), \
             patch.object(server, "store", store):
            (text, images, sources) = run(server._run_turn("k", "fast", HISTORY, _deltas))
        self.assertEqual(text, TEXT)
        self.assertEqual([a.index for a, _ in pool.failures], [0])
        self.assertEqual(store.created[0][1], 1)
        # the failed slot and the winner's slot are each released exactly once
        self.assertEqual(pool.released.count(a0), 1)
        self.assertEqual(pool.released.count(a1), 1)

    def test_pick_excludes_degraded_account_while_others_exist(self):
        pool = AccountPool()
        good = make_account(0)
        degraded = make_account(1)
        degraded.degraded = True
        degraded.healthy = True  # even after a probe revives healthy
        pool._accounts = [good, degraded]
        got = run(pool.acquire_many(4))
        self.assertEqual([a.index for a in got], [0])

    def test_pick_excludes_degraded_with_unexpired_deadline(self):
        # quarantine in force: no other accounts, but the deadline has not
        # passed -> pool is empty, never a degraded account
        pool = AccountPool()
        degraded = make_account(0)
        degraded.degraded = True
        degraded.cooldown_until = 10 ** 9
        pool._accounts = [degraded]
        self.assertEqual(run(pool.acquire_many(2)), [])

    def test_pick_expired_degraded_used_as_last_resort(self):
        # quarantine deadline passed and nothing else is usable: the account
        # comes back; its first turn re-detects before any salad streams
        pool = AccountPool()
        degraded = make_account(0)
        degraded.degraded = True
        degraded.cooldown_until = 0.0
        pool._accounts = [degraded]
        got = run(pool.acquire_many(2))
        self.assertEqual([a.index for a in got], [0])

    def test_mark_error_degraded_bounds_quarantine_through_success(self):
        acc = make_account(0)
        acc.mark_error("gateway searched content unrelated to the request (degraded account)")
        self.assertTrue(acc.degraded)
        self.assertFalse(acc.healthy)
        deadline = acc.cooldown_until
        self.assertGreater(deadline, time.monotonic())
        # a successful probe must not revive the account NOR shorten the
        # quarantine deadline
        acc.mark_success()
        self.assertTrue(acc.healthy)
        self.assertTrue(acc.degraded)
        self.assertEqual(acc.cooldown_until, deadline)

    def test_mark_success_after_quarantine_expiry_clears_degraded(self):
        # Once the quarantine deadline has passed, a successful turn/probe
        # proves the account recovered: it rejoins primary rotation. A
        # still-degraded gateway re-flags on its first bad turn.
        acc = make_account(0)
        acc.mark_error("gateway searched content unrelated to the request (degraded account)")
        self.assertTrue(acc.degraded)
        acc.cooldown_until = time.monotonic() - 1  # quarantine expired
        acc.mark_success()
        self.assertFalse(acc.degraded)
        self.assertTrue(acc.healthy)
        self.assertEqual(acc.cooldown_until, 0.0)

    def test_expired_degraded_account_rejoins_primary_rotation(self):
        pool = AccountPool()
        recovered = make_account(0)
        recovered.degraded = True
        recovered.cooldown_until = time.monotonic() - 1
        pool._accounts = [recovered]
        # last-resort pick serves it...
        self.assertEqual([a.index for a in run(pool.acquire_many(1))], [0])
        # ...and success clears the flag so pick()'s primary tier admits it
        pool.report_success(recovered)
        self.assertFalse(recovered.degraded)

    def test_mark_error_plain_degraded_word_does_not_quarantine(self):
        # only the concrete "(degraded account)" signature quarantines;
        # unrelated upstream errors that merely contain the word do not
        acc = make_account(0)
        acc.mark_error("connection quality degraded, retrying")
        self.assertFalse(acc.degraded)
        self.assertTrue(acc.healthy)

    def test_mark_success_clears_cooldown_for_normal_accounts(self):
        acc = make_account(0)
        acc.mark_error("quota exhausted (0 remaining queries)")
        acc.mark_success()
        self.assertEqual(acc.cooldown_until, 0.0)
        self.assertTrue(acc.healthy)


if __name__ == "__main__":
    unittest.main()