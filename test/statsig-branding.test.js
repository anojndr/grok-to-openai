import test from "node:test";
import assert from "node:assert/strict";
import {
  extractStatsigBrandingFromHtml,
  fetchStatsigBranding
} from "../src/grok/browser-session.js";

// The statsig middleware fingerprints the "loading X" logo and folds the
// curve path values into the id. The curves + css_class live in the
// __next_f payload of the /login route; the bridge re-stamps them onto its
// stand-ins so generated ids carry the exact per-deploy values xAI expects.
// If this parsing ever breaks, statsig generation regresses to synthetic
// curves and xAI rejects every id with "Request rejected by anti-bot rules".

function buildLoginHtml(curves, cssClass) {
  const payload = JSON.stringify({ curves, css_class: cssClass });
  const escaped = payload.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    "<!doctype html><html><head>",
    '<script>self.__next_f.push([1,"__escaped__"])</script>',
    "</head><body></body></html>"
  ].join("\n").replace("__escaped__", escaped);
}

const sampleCurves = [
  [
    { color: [53, 55, 187, 214, 92, 182], deg: 114, bezier: [36, 217, 31, 103] },
    { color: [89, 169, 75, 93, 88, 73], deg: 124, bezier: [117, 59, 241, 70] }
  ],
  [
    { color: [140, 235, 72, 240, 217, 197], deg: 53, bezier: [233, 191, 4, 233] },
    { color: [151, 22, 184, 70, 93, 171], deg: 49, bezier: [132, 153, 230, 191] }
  ],
  [
    { color: [159, 152, 197, 217, 107, 180], deg: 149, bezier: [167, 196, 115, 131] },
    { color: [117, 115, 136, 98, 199, 51], deg: 221, bezier: [232, 239, 75, 113] }
  ],
  [
    { color: [230, 15, 89, 156, 255, 126], deg: 78, bezier: [83, 228, 6, 48] },
    { color: [214, 148, 130, 65, 151, 250], deg: 253, bezier: [97, 226, 158, 9] }
  ]
];

// Grok's real loading animation carries 16+ points per curve; the middleware
// indexes segments up to `metaBytes[43] % 16` and crashes on shorter curves.
const realLengthCurves = sampleCurves.map((curve) => {
  const extended = [...curve];
  while (extended.length < 16) {
    extended.push({ color: [1, 2, 3, 4, 5, 6], deg: 7, bezier: [8, 9, 10, 11] });
  }
  return extended;
});

test("extractStatsigBrandingFromHtml parses curves + css_class from the login __next_f payload", () => {
  const html = buildLoginHtml(sampleCurves, "r-gtuf8w");
  const branding = extractStatsigBrandingFromHtml(html);

  assert.ok(branding, "branding must be extracted");
  assert.deepEqual(branding.curves, sampleCurves);
  assert.equal(branding.cssClass, "r-gtuf8w");
});

test("extractStatsigBrandingFromHtml returns null when the payload lacks curves", () => {
  const html = "<html><body><script>self.__next_f.push([1,\"\\\"no_curves_here\\\"\"])</script></body></html>";
  assert.equal(extractStatsigBrandingFromHtml(html), null);
});

test("extractStatsigBrandingFromHtml returns null for a page without __next_f", () => {
  assert.equal(extractStatsigBrandingFromHtml("<html><body>hi</body></html>"), null);
});

test("the extracted curves must carry enough segments for the middleware's R[O] indexing", () => {
  // The middleware indexes the parsed curve path segments by
  // `metaBytes[43] % 16`, so any stand-in built from the extracted curves
  // needs at least 16 segments per curve or generation crashes.
  const html = buildLoginHtml(realLengthCurves, "r-gtuf8w");
  const branding = extractStatsigBrandingFromHtml(html);
  assert.ok(branding.curves.every((curve) => curve.length >= 16));
});

test("fetchStatsigBranding accepts /login 404 responses that still carry the app HTML", async () => {
  // grok.com serves /login as HTTP 404 with the full app HTML (anti-bot
  // routing). Treating non-ok as failure drops the only per-deploy source of
  // real logo curves, so the stand-ins fall back to synthetic values and xAI
  // rejects every generated id with "Request rejected by anti-bot rules.".
  const html = buildLoginHtml(realLengthCurves, "r-gtuf8w");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    headers: { get: () => "text/html; charset=utf-8" },
    text: async () => html
  });

  try {
    const branding = await fetchStatsigBranding("https://grok.com");
    assert.ok(branding, "branding must be extracted from the 404 body");
    assert.equal(branding.cssClass, "r-gtuf8w");
    assert.ok(branding.curves.every((curve) => curve.length >= 16));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchStatsigBranding stays null for non-HTML failure bodies", async () => {
  // A challenge page or API error must not be parsed as branding.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    headers: { get: () => "application/json" },
    text: async () => "{\"error\":\"blocked\"}"
  });

  try {
    const branding = await fetchStatsigBranding("https://grok.com");
    assert.equal(branding, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchStatsigBranding returns null when the body has no branding payload", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "text/html; charset=utf-8" },
    text: async () => "<html><body>challenge</body></html>"
  });

  try {
    const branding = await fetchStatsigBranding("https://grok.com");
    assert.equal(branding, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});