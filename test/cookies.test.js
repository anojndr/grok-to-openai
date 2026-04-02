import test from "node:test";
import assert from "node:assert/strict";
import { parseNetscapeCookieText } from "../src/lib/cookies.js";

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
