import test from "node:test";
import assert from "node:assert/strict";
import { listModels, resolveModel } from "../src/grok/model-map.js";

test("resolveModel detects mode aliases embedded in model names", () => {
  assert.equal(resolveModel("grok fast").grokModeId, "fast");
  assert.equal(resolveModel("grok-3-expert").grokModeId, "expert");
  assert.equal(resolveModel("grok_auto").grokModeId, "auto");
  assert.equal(resolveModel("grok-4-heavy").grokModeId, "heavy");
  assert.equal(resolveModel("grok heavy").grokModeId, "heavy");
});

test("listModels exposes Grok Heavy as a supported public model", () => {
  assert.ok(listModels().some((model) => model.id === "grok-4-heavy"));
});
