"""Tests for accounts.txt parsing.

Pins the Netscape cookie-block contract: browser exports mark HttpOnly
cookies with a '#HttpOnly_' prefix, and grok's sso/sso-rw session cookies
are typically HttpOnly — those lines are data, not comments. A block whose
session cookie only appears behind that prefix must still parse.
Run:  ./.venv/bin/python -m unittest -v tests.test_accounts
"""
from __future__ import annotations

import unittest

from accounts import parse_accounts_file, parse_cookie_block

HTTTPONLY_LINE = (
    "#HttpOnly_.grok.com\tTRUE\t/\tTRUE\t1900000000\tsso\tqwerty123"
)
PLAIN_SSO_LINE = (
    ".grok.com\tTRUE\t/\tTRUE\t1900000000\tsso-rw\tabcdef456"
)
USERID_LINE = (
    ".grok.com\tTRUE\t/\tFALSE\t1900000000\tx-userid\tuser-42"
)


class ParseCookieBlockTests(unittest.TestCase):
    def test_httponly_prefix_line_is_data_not_comment(self):
        cookies = parse_cookie_block(HTTTPONLY_LINE + "\n" + USERID_LINE)
        self.assertEqual(cookies.get("sso"), "qwerty123")
        self.assertEqual(cookies.get("x-userid"), "user-42")

    def test_plain_lines_still_parse(self):
        cookies = parse_cookie_block(PLAIN_SSO_LINE)
        self.assertEqual(cookies.get("sso-rw"), "abcdef456")

    def test_real_comments_are_skipped(self):
        cookies = parse_cookie_block(
            "# a genuine comment\n" + PLAIN_SSO_LINE + "\n# another\n")
        self.assertEqual(cookies, {"sso-rw": "abcdef456"})

    def test_httponly_block_survives_parse_accounts_file(self):
        # Regression: a block carrying only an #HttpOnly_ sso cookie used to
        # be discarded as 'not a grok session block', silently shrinking the
        # account pool.
        text = f"account 1:\n{HTTTPONLY_LINE}\n{USERID_LINE}\n"
        accounts = parse_accounts_file(text)
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0].get("sso"), "qwerty123")
        self.assertEqual(accounts[0].get("x-userid"), "user-42")

    def test_block_without_grok_session_cookies_rejected(self):
        text = ("account 1:\n"
                ".example.com\tTRUE\t/\tFALSE\t1900000000\tother\tv\n")
        self.assertEqual(parse_accounts_file(text), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
