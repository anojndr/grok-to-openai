import test from "node:test";
import assert from "node:assert/strict";
import {
  parseNetscapeCookieText,
  parseNetscapeCookieTextGroups
} from "../src/lib/cookies.js";

test("parseNetscapeCookieText parses cookie lines", () => {
  const cookies = parseNetscapeCookieText(`
# Netscape HTTP Cookie File
.grok.com\tTRUE\t/\tTRUE\t1790626586\tsso\tabc123
grok.com\tFALSE\t/\tFALSE\t1806613002\ti18nextLng\ten
`);

  assert.equal(cookies.length, 2);
  assert.equal(cookies[0].name, "sso");
  assert.equal(cookies[0].domain, "grok.com");
  assert.equal(cookies[0].secure, true);
  assert.equal(cookies[1].name, "i18nextLng");
  assert.equal(cookies[1].value, "en");
});

test("parseNetscapeCookieTextGroups preserves top-to-bottom account blocks", () => {
  const groups = parseNetscapeCookieTextGroups(`
# Netscape HTTP Cookie File
.grok.com\tTRUE\t/\tTRUE\t1790626586\tsso\taccount-1
grok.com\tFALSE\t/\tFALSE\t1806613002\ti18nextLng\ten

# Netscape HTTP Cookie File
.grok.com\tTRUE\t/\tTRUE\t1790626586\tsso\taccount-2
grok.com\tFALSE\t/\tFALSE\t1806613002\ti18nextLng\ten

# Netscape HTTP Cookie File
.grok.com\tTRUE\t/\tTRUE\t1790626586\tsso\taccount-3
grok.com\tFALSE\t/\tFALSE\t1806613002\ti18nextLng\ten
`);

  assert.equal(groups.length, 3);
  assert.equal(groups[0][0].value, "account-1");
  assert.equal(groups[1][0].value, "account-2");
  assert.equal(groups[2][0].value, "account-3");
});
