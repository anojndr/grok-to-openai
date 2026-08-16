// live-stress-continuations.js - live load test over Responses continuations.
//
// Grok.com's per-account quota gates NEW conversations (/conversations/new),
// which exhausted the pool under fresh-conversation load. Follow-up messages
// on EXISTING threads (/conversations/:id/responses) are not gated the same
// way, so a chain of `previous_response_id` requests exercises the bridge at
// full speed without burning the new-conversation budget.
//
// Each logical request is a Responses continuation of the previous one; the
// response id of each reply becomes the previous_response_id of the next.
// Entry threads are read from STRESS_ENTRY_IDS (comma-separated response
// ids already stored in the response store; required).
//
// Exit code 1 if any request fails (non-2xx / network error).
//
// Environment:
//   STRESS_TOTAL            request count (default 50)
//   STRESS_ENTRY_IDS        comma-separated stored response ids to start chains
//   STRESS_BASE_URL         server base URL (default http://127.0.0.1:62774)
//   STRESS_API_KEY          bearer key (default sk-local-test)
//   STRESS_MODEL            model id (default grok-4.6-fast)
//   STRESS_REPORT           JSON report path
//   STRESS_LATENCY_WARN_MS  per-request warning threshold (default 30000)
//   STRESS_BASE_DELAY_MS    inter-request delay (default 3000)
//   STRESS_DELAY_JITTER_MS  extra random delay (default 2000)

import { writeFile, readFile } from "node:fs/promises";

const CHECKPOINT_PATH =
  process.env.STRESS_CHECKPOINT ?? "/tmp/live-stress-checkpoint.json";

const TOTAL = Number(process.env.STRESS_TOTAL ?? 50);
const ENTRY_IDS = (process.env.STRESS_ENTRY_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const BASE_URL = process.env.STRESS_BASE_URL ?? "http://127.0.0.1:62774";
const API_KEY = process.env.STRESS_API_KEY ?? "sk-local-test";
const MODEL = process.env.STRESS_MODEL ?? "grok-4.6-fast";
const REPORT_PATH = process.env.STRESS_REPORT ?? ".data/live-stress-continuations-results.json";
const LATENCY_WARN_MS = Number(process.env.STRESS_LATENCY_WARN_MS ?? 30000);
const BASE_DELAY_MS = Number(process.env.STRESS_BASE_DELAY_MS ?? 3000);
const DELAY_JITTER_MS = Number(process.env.STRESS_DELAY_JITTER_MS ?? 2000);

if (!ENTRY_IDS.length) {
  throw new Error("STRESS_ENTRY_IDS is required (comma-separated stored response ids)");
}

const PROMPTS = [
  "Reply with the single word PONG.",
  "What is 2+2? Reply with just the number.",
  "Name the color of the sky in one word.",
  "Reply with the single word READY.",
  "Reply with the single word OK."
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function seconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

async function sendContinuation(previousResponseId, prompt) {
  const startedAt = Date.now();
  let status = null;
  let body = null;
  let error = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4 * 60 * 1000);
    try {
      const response = await fetch(`${BASE_URL}/v1/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL,
          previous_response_id: previousResponseId,
          input: prompt
        }),
        signal: controller.signal
      });
      status = response.status;
      body = await response.json();
    } finally {
      clearTimeout(timeout);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    status = 0;
  }

  return {
    prompt,
    status,
    ok: status >= 200 && status < 300,
    durationMs: Date.now() - startedAt,
    nextResponseId: body?.id ?? null,
    error:
      error ??
      (status >= 200 && status < 300 ? null : JSON.stringify(body ?? null).slice(0, 300))
  };
}

const results = [];
let chainCursor = 0;
const startedAt = Date.now();
const WALL_MAX_MS = Number(process.env.STRESS_WALL_MAX_MS ?? 3 * 60 * 60 * 1000);
const MAX_ATTEMPTS = 40;

// One chain per entry thread: follow-ups stay on the thread's owner account,
// so generation quota is spread across the pool. Stick with the current chain
// while it succeeds; when it is rate-limited, rotate to the next chain whose
// account may have recharged (per-account windows stagger).
const chains = ENTRY_IDS.map((entryId) => ({ entryId, lastResponseId: null }));

async function loadCheckpoint() {
  try {
    const raw = await readFile(CHECKPOINT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.chains) && parsed.chains.length === chains.length) {
      for (let c = 0; c < chains.length; c += 1) {
        chains[c].lastResponseId = parsed.chains[c] ?? null;
      }
      return parsed.completed ?? 0;
    }
  } catch {
    // no checkpoint yet
  }
  return 0;
}

async function saveCheckpoint(completed) {
  await writeFile(
    CHECKPOINT_PATH,
    `${JSON.stringify({
      completed,
      chains: chains.map((c) => c.lastResponseId)
    })}\n`
  );
}

const resumed = await loadCheckpoint();

for (let i = 0; i < TOTAL; i += 1) {
  // Resume support: skip logical requests completed in a prior run (their
  // chain state is already in the checkpoint).
  if (i < resumed) {
    console.log(`[${String(i + 1).padStart(String(TOTAL).length, "0")}/${TOTAL}] skipped (resume)`);
    continue;
  }

  const prompt = PROMPTS[i % PROMPTS.length];
  const chain = chains[chainCursor];
  const previousId = chain.lastResponseId ?? chain.entryId;

  let result = null;
  let consecutiveFailures = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (Date.now() - startedAt > WALL_MAX_MS) {
      throw new Error(`test exceeded wall-clock budget ${WALL_MAX_MS}ms`);
    }

    const attemptResult = await sendContinuation(previousId, prompt);
    if (attemptResult.ok) {
      result = { ...attemptResult, attempts: attempt, chain: chainCursor };
      chain.lastResponseId = attemptResult.nextResponseId;
      break;
    }

    consecutiveFailures += 1;
    // Retryable: pool exhaustion, rate limit, upstream 502, transport error.
    const retryable =
      attemptResult.status === 503 ||
      attemptResult.status === 429 ||
      attemptResult.status === 502 ||
      attemptResult.status === 0;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      result = { ...attemptResult, attempts: attempt, chain: chainCursor };
      break;
    }

    console.log(
      `  -> attempt ${attempt}/${MAX_ATTEMPTS} status=${attemptResult.status} ` +
        `waiting 90s (${attemptResult.error})`
    );
    // Gentle recovery poll: probing too fast re-trips an account the moment
    // its window reopens and delays the pool's staggered recovery. 90s lands
    // probes only on accounts whose cooldown actually expired.
    await sleep(90000);

    // After a few consecutive failures, rotate to the next chain: another
    // account may have recharged while this one stays saturated. Rotating
    // chains never creates new conversations (all seeds are stored threads).
    if (consecutiveFailures >= 3) {
      chainCursor = (chainCursor + 1) % chains.length;
      const nextChain = chains[chainCursor];
      const nextPreviousId = nextChain.lastResponseId ?? nextChain.entryId;
      console.log(`  -> rotating to chain ${chainCursor} (${String(nextPreviousId).slice(-12)})`);
      // Continue the retry loop against the new chain's thread.
      const rotated = await sendContinuation(nextPreviousId, prompt);
      if (rotated.ok) {
        result = { ...rotated, attempts: attempt + 1, chain: chainCursor };
        nextChain.lastResponseId = rotated.nextResponseId;
        break;
      }
      consecutiveFailures = 0;
    }
  }

  if (!result) {
    throw new Error(`No response available at logical request ${i + 1}`);
  }

  results.push(result);
  await saveCheckpoint(i + 1);

  const flag = result.ok ? "ok" : `ERROR(status=${result.status})`;
  const warn = result.ok && result.durationMs > LATENCY_WARN_MS ? " SLOW" : "";
  console.log(
    `[${String(i + 1).padStart(String(TOTAL).length, "0")}/${TOTAL}] ` +
      `${flag} ${result.durationMs}ms (${result.attempts} attempts)${warn} "${prompt}" ` +
      `chain=${result.chain} prev=${String(previousId).slice(-12)}`
  );
  if (!result.ok) {
    console.error(`  -> ${result.error}`);
  }

  if (i < TOTAL - 1) {
    await sleep(BASE_DELAY_MS + Math.floor(Math.random() * (DELAY_JITTER_MS + 1)));
  }
}

const elapsedMs = Date.now() - startedAt;
const reportedTotal = Math.max(TOTAL, resumed);
const successful = resumed + results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
const slow = results.filter((r) => r.ok && r.durationMs > LATENCY_WARN_MS);
const latencies = results.filter((r) => r.ok).map((r) => r.durationMs).sort((a, b) => a - b);
const summarize = (list) => {
  if (!list.length) {
    return null;
  }
  const sum = list.reduce((acc, v) => acc + v, 0);
  return {
    count: list.length,
    minMs: list[0],
    p50Ms: list[Math.floor(list.length / 2)],
    p95Ms: list[Math.min(list.length - 1, Math.ceil(list.length * 0.95) - 1)],
    maxMs: list[list.length - 1],
    meanMs: Math.round(sum / list.length)
  };
};

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  model: MODEL,
  total: TOTAL,
  resumed,
  entryIds: ENTRY_IDS,
  elapsedMs,
  elapsed: seconds(elapsedMs),
  successful,
  failedCount: failed.length,
  successRate: `${(successful / Math.max(reportedTotal, 1)) * 100}%`,
  slowCount: slow.length,
  latency: {
    successful: summarize(latencies),
    failed: summarize(failed.map((r) => r.durationMs).sort((a, b) => a - b))
  },
  failures: failed.map((r, idx) => ({
    index: idx,
    prompt: r.prompt,
    status: r.status,
    durationMs: r.durationMs,
    error: r.error
  })),
  slowRequests: slow.map((r, idx) => ({
    index: idx,
    prompt: r.prompt,
    durationMs: r.durationMs
  }))
};

await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote report to ${REPORT_PATH}`);
console.log(
  `RESULT: ${successful}/${TOTAL} succeeded (${report.successRate}) ` +
    `in ${report.elapsed}; slow(>${LATENCY_WARN_MS}ms)=${slow.length}`
);

if (failed.length || slow.length) {
  console.error(`FAILED: ${failed.length} errors, ${slow.length} slow requests`);
  process.exitCode = 1;
}
