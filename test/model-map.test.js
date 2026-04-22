import test from "node:test";
import assert from "node:assert/strict";
import { listModels, resolveModel } from "../src/grok/model-map.js";

test("resolveModel detects mode aliases embedded in model names", () => {
  assert.equal(resolveModel("grok fast").grokModeId, "fast");
  assert.equal(resolveModel("grok-3-expert").grokModeId, "expert");
  assert.equal(resolveModel("grok_auto").grokModeId, "auto");
  assert.equal(resolveModel("grok-4-heavy").grokModeId, "heavy");
  assert.equal(resolveModel("grok heavy").grokModeId, "heavy");
  assert.equal(
    resolveModel("Grok 4.3 (beta)").grokModeId,
    "grok-420-computer-use-sa"
  );
  assert.equal(
    resolveModel("grok-420-computer-use-sa").grokModeId,
    "grok-420-computer-use-sa"
  );
});

test("listModels exposes Grok Heavy as a supported public model", () => {
  assert.ok(listModels().some((model) => model.id === "grok-4-heavy"));
  assert.ok(listModels().some((model) => model.id === "grok-4.3-beta"));
});
