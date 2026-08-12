import test from "node:test";
import assert from "node:assert/strict";
import { listModels, resolveModel } from "../src/grok/model-map.js";

test("resolveModel detects mode aliases embedded in model names", () => {
  assert.equal(resolveModel("grok fast").grokModeId, "fast");
  assert.equal(resolveModel("custom-expert-model").grokModeId, "expert");
  assert.equal(resolveModel("grok_auto").grokModeId, "auto");
  assert.equal(resolveModel("grok-4.6-heavy").grokModeId, "heavy");
  assert.equal(resolveModel("grok heavy").grokModeId, "heavy");
  assert.equal(resolveModel("grok-4.6-fast").grokModeId, "fast");
  assert.equal(resolveModel("grok-4.6-expert").grokModeId, "expert");
  assert.equal(resolveModel("grok-4.6-heavy").grokModeId, "heavy");
  assert.equal(resolveModel("grok-4.6-auto").grokModeId, "auto");
  assert.equal(resolveModel("grok-4.6").grokModeId, "auto");
  assert.equal(
    resolveModel("Grok 4.6 (beta)").grokModeId,
    "grok-420-computer-use-sa"
  );
  assert.equal(
    resolveModel("grok-420-computer-use-sa").grokModeId,
    "grok-420-computer-use-sa"
  );
});

test("listModels exposes Grok 4.6 models", () => {
  assert.ok(listModels().some((model) => model.id === "grok-4.6-heavy"));
  assert.ok(listModels().some((model) => model.id === "grok-4.6-beta"));
  assert.ok(listModels().some((model) => model.id === "grok-4.6-fast"));
  assert.ok(listModels().some((model) => model.id === "grok-4.6-expert"));
});
