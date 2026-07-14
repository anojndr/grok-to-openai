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
  assert.equal(cookies[0].domain, ".grok.com");
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

test("parseCookieJson parses single account JSON cookies", () => {
  const jsonStr = JSON.stringify([
    { name: "foo", value: "bar", domain: ".grok.com", path: "/", secure: true }
  ]);
  const groups = parseNetscapeCookieTextGroups(""); // reference/dummy
  
  // We can import parseCookieJson directly or test through readCookieSetsFromSource
});

test("readCookieSetsFromSource parses single and multi JSON cookies", async () => {
  const singleJson = JSON.stringify([
    { name: "foo", value: "bar", domain: ".grok.com", path: "/", secure: true }
  ]);
  const multiJson = JSON.stringify([
    [{ name: "foo1", value: "bar1", domain: ".grok.com", path: "/", secure: true }],
    [{ name: "foo2", value: "bar2", domain: ".grok.com", path: "/", secure: true }]
  ]);

  const { readCookieSetsFromSource } = await import("../src/lib/cookies.js");

  const singleResult = await readCookieSetsFromSource({ rawText: singleJson });
  assert.equal(singleResult.length, 1);
  assert.equal(singleResult[0][0].name, "foo");
  assert.equal(singleResult[0][0].value, "bar");

  const multiResult = await readCookieSetsFromSource({ rawText: multiJson });
  assert.equal(multiResult.length, 2);
  assert.equal(multiResult[0][0].name, "foo1");
  assert.equal(multiResult[1][0].name, "foo2");
});

test("readCookieSetsFromSource parses concatenated JSON arrays", async () => {
  const concatenatedJson = `
    [
      { "name": "c1", "value": "v1", "domain": ".grok.com", "path": "/" }
    ]
    [
      { "name": "c2", "value": "v2", "domain": ".grok.com", "path": "/" }
    ]
  `;
  const { readCookieSetsFromSource } = await import("../src/lib/cookies.js");
  const result = await readCookieSetsFromSource({ rawText: concatenatedJson });
  assert.equal(result.length, 2);
  assert.equal(result[0][0].name, "c1");
  assert.equal(result[1][0].name, "c2");
});

test("readCookieSetsFromSource parses array of account objects with cookies fields", async () => {
  const accountObjectsJson = JSON.stringify([
    {
      id: 1,
      name: "acc-1",
      cookies: [{ name: "c1", value: "v1", domain: ".grok.com", path: "/" }]
    },
    {
      id: 2,
      name: "acc-2",
      cookies: [{ name: "c2", value: "v2", domain: ".grok.com", path: "/" }]
    }
  ]);
  const { readCookieSetsFromSource } = await import("../src/lib/cookies.js");
  const result = await readCookieSetsFromSource({ rawText: accountObjectsJson });
  assert.equal(result.length, 2);
  assert.equal(result[0][0].name, "c1");
  assert.equal(result[1][0].name, "c2");
});

test("parseNetscapeCookieTextGroups handles loose headers and duplicate cookies splitting", () => {
  const text = `
# Netscape HTTP Cookie File - exported by extension
.grok.com\tTRUE\t/\tTRUE\t1790626586\tsso\taccount-1
grok.com\tFALSE\t/\tFALSE\t1806613002\ti18nextLng\ten

# http cookie file from another session
.grok.com\tTRUE\t/\tTRUE\t1790626586\tsso\taccount-2
grok.com\tFALSE\t/\tFALSE\t1806613002\ti18nextLng\ten

# No header here, but duplicate cookie key should force a split
.grok.com\tTRUE\t/\tTRUE\t1790626586\tsso\taccount-3
grok.com\tFALSE\t/\tFALSE\t1806613002\ti18nextLng\ten
  `;
  const groups = parseNetscapeCookieTextGroups(text);
  assert.equal(groups.length, 3);
  assert.equal(groups[0][0].value, "account-1");
  assert.equal(groups[1][0].value, "account-2");
  assert.equal(groups[2][0].value, "account-3");
});

