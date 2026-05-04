import test from "node:test";
import assert from "node:assert/strict";
import { withFastModelFallback } from "../src/grok/model-fallback.js";
import { HttpError } from "../src/lib/errors.js";
import { GROK_SESSION_BLOCKED_ERROR_CODE } from "../src/grok/browser-session.js";

test("withFastModelFallback retries expert requests with grok-4-fast after the first attempt fails", async () => {
  const attempts = [];

  const result = await withFastModelFallback({
    publicModel: "grok expert",
    async operation(model) {
      attempts.push(model);

      if (attempts.length === 1) {
        throw new Error("all accounts failed");
      }

      return {
        model
      };
    }
  });

  assert.deepEqual(attempts, ["grok expert", "grok-4-fast"]);
  assert.deepEqual(result, {
    model: "grok-4-fast"
  });
});

test("withFastModelFallback retries heavy requests with grok-4-fast after the first attempt fails", async () => {
  const attempts = [];

  const result = await withFastModelFallback({
    publicModel: "grok heavy",
    async operation(model) {
      attempts.push(model);

      if (attempts.length === 1) {
        throw new Error("all accounts failed");
      }

      return {
        model
      };
    }
  });

  assert.deepEqual(attempts, ["grok heavy", "grok-4-fast"]);
  assert.deepEqual(result, {
    model: "grok-4-fast"
  });
});

test("withFastModelFallback retries Grok 4.3 beta requests with grok-4-fast after the first attempt fails", async () => {
  const attempts = [];

  const result = await withFastModelFallback({
    publicModel: "grok-4.3-beta",
    async operation(model) {
      attempts.push(model);

      if (attempts.length === 1) {
        throw new Error(
          "stream response: consume xAI responses stream: browserContext.newPage: Protocol error (Target.createTarget): Failed to open a new tab type=server_error: invalid argument"
        );
      }

      return {
        model
      };
    }
  });

  assert.deepEqual(attempts, ["grok-4.3-beta", "grok-4-fast"]);
  assert.deepEqual(result, {
    model: "grok-4-fast"
  });
});

test("withFastModelFallback does not retry requests that are already grok fast", async () => {
  const attempts = [];

  await assert.rejects(
    withFastModelFallback({
      publicModel: "grok fast",
      async operation(model) {
        attempts.push(model);
        throw new Error("still failing");
      }
    }),
    /still failing/
  );

  assert.deepEqual(attempts, ["grok fast"]);
});

test("withFastModelFallback does not hide blocked Grok sessions with a model retry", async () => {
  const attempts = [];

  await assert.rejects(
    withFastModelFallback({
      publicModel: "grok-4-auto",
      async operation(model) {
        attempts.push(model);
        throw new HttpError(502, "blocked", {
          code: GROK_SESSION_BLOCKED_ERROR_CODE
        });
      }
    }),
    (error) => error?.details?.code === GROK_SESSION_BLOCKED_ERROR_CODE
  );

  assert.deepEqual(attempts, ["grok-4-auto"]);
});
