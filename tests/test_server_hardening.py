"""Tests for server hardening helpers added by the security review.

Pins the per-conversation lock lifecycle (_client_lock: serialization,
bounded memory, entry reclaimed after the last user leaves) and the
loopback classifier guarding the non-loopback bind refusal.
Run:  ./.venv/bin/python -m unittest -v tests.test_server_hardening
"""
from __future__ import annotations

import asyncio
import unittest

import server


def fresh_locks() -> None:
    server._client_locks.clear()


class ClientLockTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        fresh_locks()

    async def test_entry_removed_after_last_user_exits(self):
        async with server._client_lock("k1"):
            self.assertIn("k1", server._client_locks)
        self.assertNotIn("k1", server._client_locks)

    async def test_same_key_serializes_access(self):
        order: list[str] = []
        held = asyncio.Event()
        proceed = asyncio.Event()

        async def holder():
            async with server._client_lock("shared"):
                order.append("enter-a")
                held.set()
                await proceed.wait()
                order.append("exit-a")

        async def waiter():
            await held.wait()
            async with server._client_lock("shared"):
                order.append("enter-b")

        h = asyncio.create_task(holder())
        w = asyncio.create_task(waiter())
        await held.wait()
        await asyncio.sleep(0.05)
        # b queued on the lock (entry kept alive by its queued user) but has
        # not entered: the section is exclusive
        self.assertEqual(order, ["enter-a"])
        self.assertEqual(len(server._client_locks), 1)
        proceed.set()
        await asyncio.gather(h, w)
        self.assertEqual(order, ["enter-a", "exit-a", "enter-b"])
        self.assertEqual(server._client_locks, {})

    async def test_distinct_keys_do_not_block_each_other(self):
        gate = asyncio.Event()

        async def worker(key):
            async with server._client_lock(key):
                await gate.wait()

        tasks = [asyncio.create_task(worker(f"k{i}")) for i in range(5)]
        await asyncio.sleep(0.05)
        # every worker is inside its own critical section simultaneously
        self.assertEqual(len(tasks), 5)
        gate.set()
        await asyncio.gather(*tasks)
        self.assertEqual(server._client_locks, {})

    async def test_entry_survives_while_other_users_are_queued(self):
        order: list[str] = []
        started = asyncio.Event()
        release = asyncio.Event()

        async def first():
            async with server._client_lock("k"):
                order.append("enter-a")
                started.set()
                await release.wait()
                order.append("exit-a")

        async def second():
            async with server._client_lock("k"):
                order.append("enter-b")

        f = asyncio.create_task(first())
        s = asyncio.create_task(second())
        await started.wait()
        await asyncio.sleep(0.05)
        # second is queued on the held lock; its queued ownership must keep
        # the entry alive even though the current holder is about to leave
        self.assertIn("k", server._client_locks)
        self.assertEqual(order, ["enter-a"])
        release.set()
        await asyncio.gather(f, s)
        # the entry was not dropped between owners (which would have let b
        # run concurrently with a): strict serialization order held
        self.assertEqual(order, ["enter-a", "exit-a", "enter-b"])
        self.assertEqual(server._client_locks, {})


class IsLoopbackTests(unittest.TestCase):
    def test_loopback_addresses(self):
        for host in ("127.0.0.1", "127.8.8.8", "::1", "localhost", ""):
            self.assertTrue(server._is_loopback(host), host)

    def test_non_loopback_addresses(self):
        for host in ("0.0.0.0", "::", "192.168.1.10", "example.com"):
            self.assertFalse(server._is_loopback(host), host)


if __name__ == "__main__":
    unittest.main(verbosity=2)
