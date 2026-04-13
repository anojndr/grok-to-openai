import test from "node:test";
import assert from "node:assert/strict";
import { writeSseEvent } from "../src/openai/sse.js";

test("writeSseEvent writes one complete SSE frame", () => {
  const writes = [];
  const res = {
    write(chunk) {
      writes.push(chunk);
    }
  };

  writeSseEvent(res, "response.created", {
    id: "resp_123",
    status: "in_progress"
  });

  assert.deepEqual(writes, [
    'event: response.created\ndata: {"id":"resp_123","status":"in_progress"}\n\n'
  ]);
});
