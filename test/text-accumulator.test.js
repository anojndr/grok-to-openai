import test from "node:test";
import assert from "node:assert/strict";
import { createTextAccumulator } from "../src/lib/text-accumulator.js";

test("createTextAccumulator appends streamed chunks and joins on demand", () => {
  const accumulator = createTextAccumulator();

  accumulator.append("Hello");
  accumulator.append(", ");
  accumulator.append("world");

  assert.equal(accumulator.isEmpty(), false);
  assert.equal(accumulator.toString(), "Hello, world");
});

test("createTextAccumulator can replace buffered text before appending more", () => {
  const accumulator = createTextAccumulator();

  accumulator.append("Draft");
  accumulator.set("Final");
  accumulator.append(" answer.");

  assert.equal(accumulator.toString(), "Final answer.");
});
