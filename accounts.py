"""Account loading + load balancing for grok.com cookie accounts.

accounts.txt format: any number of "Netscape HTTP Cookie File" blocks
(optionally separated by "account N:" headers). Each block must contain
the `sso` cookie (and usually `sso-rw`, `cf_clearance`, `x-userid`).

The pool is dynamic: the file is re-parsed whenever its mtime changes, so
accounts can be added/removed at runtime without restarting the server.
"""
from __future__ import annotations

import asyncio
import itertools
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_ACCOUNTS_FILE = Path(__file__).parent / "accounts.txt"

COOKIE_RE = re.compile(r"^(\S+)\s+(TRUE|FALSE)\s+(\S+)\s+(TRUE|FALSE)\s+(\d+)\s+(\S+)\s+(\S+)\s*$")
BLOCK_HEADER_RE = re.compile(r"^\s*account\s*\d+\s*:\s*$")


@dataclass
class Account:
    index: int
    label: str
    cookies: dict[str, str]
    x_userid: str | None = None
    healthy: bool = True
    in_flight: int = 0
    consecutive_errors: int = 0
    cooldown_until: float = 0.0
    remaining_queries: int | None = None
    last_error: str = ""
    last_probe: float = 0.0

    @property
    def cookie_header(self) -> str:
        return "; ".join(f"{k}={v}" for k, v in self.cookies.items())

    def mark_error(self, reason: str) -> None:
        self.consecutive_errors += 1
        self.last_error = reason
        backoff = min(60 * (2 ** min(self.consecutive_errors - 1, 4)), 3600)
        self.cooldown_until = time.monotonic() + backoff
        lower = reason.lower()
        if any(token in lower for token in ("401", "unauthenticated", "invalid session", "failed to look up session")):
            self.healthy = False
        elif self.consecutive_errors >= 3:
            self.healthy = False

    def mark_success(self) -> None:
        self.consecutive_errors = 0
        self.cooldown_until = 0.0
        self.healthy = True


def parse_cookie_block(block: str) -> dict[str, str]:
    cookies: dict[str, str] = {}
    for line in block.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = COOKIE_RE.match(line)
        if not m:
            # space-separated fallback
            parts = line.split()
            if len(parts) == 7:
                domain, sub, path, secure, exp, name, value = parts
                cookies[name] = value
            continue
        domain, sub, path, secure, exp, name, value = m.groups()
        cookies[name] = value
    return cookies


def parse_accounts_file(text: str) -> list[dict[str, str]]:
    """Return one cookie dict per account block found in the file."""
    # Split on "account N:" headers; blocks are also separated by blank lines.
    raw_blocks: list[str] = []
    current: list[str] = []
    for line in text.splitlines():
        if BLOCK_HEADER_RE.match(line):
            if current and any(l.strip() and not l.strip().startswith("#") for l in current):
                raw_blocks.append("\n".join(current))
            current = []
            continue
        if not line.strip():
            if current and any(l.strip() and not l.strip().startswith("#") for l in current):
                raw_blocks.append("\n".join(current))
                current = []
            continue
        current.append(line)
    if current and any(l.strip() and not l.strip().startswith("#") for l in current):
        raw_blocks.append("\n".join(current))

    accounts = []
    for block in raw_blocks:
        cookies = parse_cookie_block(block)
        if not cookies:
            continue
        if "sso" not in cookies and "sso-rw" not in cookies:
            continue  # not a grok session block
        accounts.append(cookies)
    return accounts


class AccountPool:
    """Thread-safe-ish pool (used from asyncio; lock guards state)."""

    def __init__(self, path: str | Path = DEFAULT_ACCOUNTS_FILE):
        self.path = Path(path)
        self._lock = asyncio.Lock()
        self._accounts: list[Account] = []
        self._rr = itertools.count()
        self._mtime: float | None = None
        self.reload()

    def reload(self, force: bool = False) -> list[Account]:
        try:
            mtime = self.path.stat().st_mtime
        except OSError:
            return self._accounts
        if not force and self._mtime == mtime:
            return self._accounts
        text = self.path.read_text(encoding="utf-8", errors="replace")
        parsed = parse_accounts_file(text)
        if not parsed:
            raise ValueError(f"no usable grok accounts found in {self.path}")
        self._accounts = [
            Account(index=i, label=f"account-{i + 1}", cookies=c,
                    x_userid=c.get("x-userid"))
            for i, c in enumerate(parsed)
        ]
        self._mtime = mtime
        return self._accounts

    def maybe_reload(self) -> None:
        try:
            self.reload()
        except Exception:
            pass

    def accounts(self) -> list[Account]:
        return list(self._accounts)

    def count(self) -> int:
        return len(self._accounts)

    def pick(self) -> Account | None:
        """Least-loaded healthy account; round-robin breaks ties."""
        self.maybe_reload()
        now = time.monotonic()
        healthy = [a for a in self._accounts if a.healthy and a.cooldown_until <= now]
        if not healthy:
            # allow cooldown-expired but previously-unhealthy accounts
            healthy = [a for a in self._accounts if a.cooldown_until <= now]
        if not healthy:
            return None
        # least in_flight, then round-robin among the least-loaded group
        min_load = min(a.in_flight for a in healthy)
        candidates = [a for a in healthy if a.in_flight == min_load]
        return candidates[next(self._rr) % len(candidates)]

    async def acquire(self) -> Account | None:
        async with self._lock:
            acc = self.pick()
            if acc:
                acc.in_flight += 1
            return acc

    async def acquire_many(self, n: int) -> list[Account]:
        """Acquire up to n distinct accounts (least-loaded, round-robin).

        Returns fewer than n when the pool cannot supply that many usable
        accounts (duplicates are never returned); an empty list means no
        account is available at all.
        """
        async with self._lock:
            picked: list[Account] = []
            for _ in range(n):
                acc = self.pick()
                if acc is None or acc in picked:
                    break
                acc.in_flight += 1
                picked.append(acc)
            return picked

    def release(self, acc: Account) -> None:
        if acc.in_flight > 0:
            acc.in_flight -= 1

    def report_success(self, acc: Account) -> None:
        acc.mark_success()

    def report_failure(self, acc: Account, reason: str) -> None:
        acc.mark_error(reason)


def load_accounts(path: str | Path = DEFAULT_ACCOUNTS_FILE) -> list[dict[str, str]]:
    return parse_accounts_file(Path(path).read_text(encoding="utf-8", errors="replace"))


if __name__ == "__main__":
    accts = load_accounts()
    print(f"parsed {len(accts)} accounts")
    for i, a in enumerate(accts):
        print(f"  {i + 1}: userid={a.get('x-userid', '?')} cookies={len(a)}")
