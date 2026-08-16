// live-stress.js - live load test against a running grok-to-openai server.
//
// Sends N POST /v1/chat/completions requests through the pooled account
// router and records per-request latency/status. The test is rate-aware:
// Grok throttles per-account after a handful of new conversations, so the
// driver paces requests (base inter-request delay + jitter) and, when the
// server reports 429/503 pool exhaustion, backs off long enough for the
// pool's cooldowns to expire and retries the logical request. A logical
// request succeeds the first time its attempt returns a 2xx.
//
// Exit code 1 if any logical request fails or any successful request exceeds
// LATENCY_WARN_MS.
//
// Environment:
//   STRESS_TOTAL            logical request count (default 50)
//   STRESS_BASE_URL         server base URL (default http://127.0.0.1:62774)
//   STRESS_API_KEY          bearer key (default sk-local-test)
//   STRESS_MODEL            model id (default grok-4.6-fast)
//   STRESS_REPORT           JSON report path (default .data/live-stress-results.json)
//   STRESS_LATENCY_WARN_MS  per-request warning threshold (default 30000)
//   STRESS_BASE_DELAY_MS    inter-request base delay (default 6000)
//   STRESS_DELAY_JITTER_MS  max extra random delay (default 3000)
//   STRESS_WALL_MAX_MS      total test deadline (default 20*60*1000)

import { writeFile } from "node:fs/promises";

const TOTAL = Number(process.env.STRESS_TOTAL ?? 50);
const BASE_URL = process.env.STRESS_BASE_URL ?? "http://127.0.0.1:62774";
const API_KEY = process.env.STRESS_API_KEY ?? "sk-local-test";
const MODEL = process.env.STRESS_MODEL ?? "grok-4.6-fast";
const REPORT_PATH = process.env.STRESS_REPORT ?? ".data/live-stress-results.json";
const LATENCY_WARN_MS = Number(process.env.STRESS_LATENCY_WARN_MS ?? 30000);
const BASE_DELAY_MS = Number(process.env.STRESS_BASE_DELAY_MS ?? 12000);
const DELAY_JITTER_MS = Number(process.env.STRESS_DELAY_JITTER_MS ?? 8000);
const WALL_MAX_MS = Number(process.env.STRESS_WALL_MAX_MS ?? 60 * 60 * 1000);

const WORK_PROMPTS = [
  "Reply with the single word PONG.",
  "What is 2+2? Reply with just the number.",
  "Name the color of the sky in one word.",
  "Reply with the single word READY.",
  "Reply with the single word OK."
];

const MAX_BACKOFF_MS = 30000;
const MAX_ATTEMPTS = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function seconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function isPoolExhaustion(status, body) {
  return status === 503 && body?.error?.code === "pool_exhausted";
}

function isRateLimited(status) {
  return status === 429;
}

async function sendRequest(prompt) {
  const startedAt = Date.now();
  let status = null;
  let body = null;
  let error = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4 * 60 * 1000);
    try {
      const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: prompt }]
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
    error:
      error ??
      (status >= 200 && status < 300 ? null : JSON.stringify(body ?? null).slice(0, 300))
  };
}

const startedAt = Date.now();
const results = [];
const attempts = [];
let consecutiveFailures = 0;

// Warm-up: the account pool may still be recovering (cooldowns from a prior
// run). Do not count stress requests against a dead pool; probe with a single
// request until the server routes it to a usable account, or give up.
{
  const warmupStart = Date.now();
  let warmupOk = false;
  while (Date.now() - warmupStart < 55 * 60 * 1000) {
    const probe = await sendRequest(WORK_PROMPTS[0]);
    if (probe.ok) {
      warmupOk = true;
      console.log(
        `[warm-up] pool ready after ${Date.now() - warmupStart}ms ` +
          `(${probe.durationMs}ms attempt)`
      );
      break;
    }
    console.log(
      `[warm-up] pool not ready (status=${probe.status}); waiting 30s: ${probe.error}`
    );
    // Slow cadence: probing too fast re-hits a saturated pool the instant a
    // cooldown expires, re-tripping the limiter and delaying the upstream
    // window from reopening. Poll just often enough to notice recovery.
    await sleep(30000);
  }
  if (!warmupOk) {
    throw new Error(
      "pool never became usable during warm-up; check server and Grok quota"
    );
  }
}

for (let i = 0; i < TOTAL; i += 1) {
  const prompt = WORK_PROMPTS[i % WORK_PROMPTS.length];
  let result = null;
  let attemptNumber = 0;

  while (attemptNumber < MAX_ATTEMPTS) {
    if (Date.now() - startedAt > WALL_MAX_MS) {
      throw new Error(`test exceeded wall-clock budget ${WALL_MAX_MS}ms`);
    }

    attemptNumber += 1;
    const attempt = await sendRequest(prompt);
    attempts.push({
      logicalIndex: i,
      attemptNumber,
      status: attempt.status,
      durationMs: attempt.durationMs
    });

    if (attempt.ok) {
      consecutiveFailures = 0;
      result = { ...attempt, attempts: attemptNumber };
      break;
    }

    consecutiveFailures += 1;
    const retryable =
      isPoolExhaustion(attempt.status, attempt.body) ||
      isRateLimited(attempt.status) ||
      attempt.status === 502 ||
      attempt.status === 0;

    if (!retryable || attemptNumber >= MAX_ATTEMPTS) {
      result = { ...attempt, attempts: attemptNumber };
      break;
    }

    const backoff = Math.min(
      MAX_BACKOFF_MS,
      1000 * 2 ** Math.min(consecutiveFailures - 1, 4)
    );
    console.log(
      `  -> attempt ${attemptNumber}/${MAX_ATTEMPTS} status=${attempt.status} ` +
        `backoff ${backoff}ms (${attempt.error})`
    );
    await sleep(backoff);
  }

  const interDelay =
    BASE_DELAY_MS + Math.floor(Math.random() * (DELAY_JITTER_MS + 1));
  if (i < TOTAL - 1) {
    await sleep(interDelay);
  }

  results.push(result);
  const flag = result.ok ? "ok" : `ERROR(status=${result.status})`;
  const warn = result.ok && result.durationMs > LATENCY_WARN_MS ? " SLOW" : "";
  console.log(
    `[${String(i + 1).padStart(String(TOTAL).length, "0")}/${TOTAL}] ` +
      `${flag} ${result.durationMs}ms (${result.attempts} attempts)${warn} "${prompt}"`
  );
  if (!result.ok) {
    console.error(`  -> ${result.error}`);
  }
}

const elapsedMs = Date.now() - startedAt;
const successful = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
const slow = results.filter((r) => r.ok && r.durationMs > LATENCY_WARN_MS);
const okLatencies = results
  .filter((r) => r.ok)
  .map((r) => r.durationMs)
  .sort((a, b) => a - b);
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
  elapsedMs,
  elapsed: seconds(elapsedMs),
  successful,
  failedCount: failed.length,
  successRate: `${(successful / Math.max(TOTAL, 1)) * 100}%`,
  slowCount: slow.length,
  attemptCount: attempts.length,
  latency: {
    successful: summarize(okLatencies),
    failed: summarize(
      failed.map((r) => r.durationMs).sort((a, b) => a - b)
    )
  },
  failures: failed.map((r) => ({
    index: results.indexOf(r),
    prompt: r.prompt,
    status: r.status,
    durationMs: r.durationMs,
    attempts: r.attempts,
    error: r.error
  })),
  slowRequests: slow.map((r) => ({
    index: results.indexOf(r),
    prompt: r.prompt,
    durationMs: r.durationMs,
    attempts: r.attempts
  })),
  attempts: attempts.map((a) => ({
    logicalIndex: a.logicalIndex,
    attemptNumber: a.attemptNumber,
    status: a.status,
    durationMs: a.durationMs
  }))
};

await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote report to ${REPORT_PATH}`);
console.log(
  `RESULT: ${successful}/${TOTAL} succeeded (${report.successRate}) ` +
    `in ${report.elapsed}; slow(>${LATENCY_WARN_MS}ms)=${slow.length}; ` +
    `total attempts=${attempts.length}; failed losers=${failed.length}`
);

if (failed.length || slow.length) {
  console.error(`FAILED: ${failed.length} errors, ${slow.length} slow requests`);
  process.exitCode = 1;
}
