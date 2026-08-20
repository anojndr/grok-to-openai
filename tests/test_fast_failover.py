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

    async def generate(self, on_delta, file_attachment_ids=None, item=None):
        if self.fail is not None:
            raise self.fail
        await on_delta(TEXT, {})
        return TEXT, [], []


class FakeManager:
    """new_turn fails or delays per account index; close_turn records."""

    def __init__(self, fail_indices=(), delays=(), turn_fail=None):
        self.fail_indices = set(fail_indices)
        self.delays = dict(delays)
        self.turn_fail = turn_fail
        self.created: list[FakeTurn] = []
        self.closed: list[FakeTurn] = []

    async def new_turn(self, account, model, conversation_id):
        if account.index in self.delays:
            await asyncio.sleep(self.delays[account.index])
        if account.index in self.fail_indices:
            raise GrokError(f"preflight failed for {account.index}", kind="connect_failed")
        turn = FakeTurn(account, fail=self.turn_fail)
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

async def test_skips_other_sessions_within_budget(self):
        ws = unittest.mock.MagicMock()
        ws.recv = unittest.mock.AsyncMock(side_effect=[
            json.dumps({"session_id": "other", "event": {"type": "stale"}}),
            json.dumps({"session_id": "mine", "event": {"type": "mine"}}),
        ])
        acc = make_account(0)
        turn = GrokTurn(acc, ws, asyncio.Lock(), model="fast")
        turn.session_id = "mine"
        msg = run(turn._recv(timeout=5))
        self.assertEqual(msg["event"]["type"], "mine")


if __name__ == "__main__":
    unittest.main()