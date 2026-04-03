import test from "node:test";
import assert from "node:assert/strict";
import { resolveModel } from "../src/grok/model-map.js";

test("resolveModel detects mode aliases embedded in model names", () => {
  assert.equal(resolveModel("grok fast").grokModeId, "fast");
  assert.equal(resolveModel("grok-3-expert").grokModeId, "expert");
  assert.equal(resolveModel("grok_auto").grokModeId, "auto");
});
