import "dotenv/config";
import path from "node:path";

const cwd = process.cwd();

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function envInteger(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue === "") {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }

  return value;
}

function resolveOptionalPath(value) {
  if (!value) {
    return "";
  }

  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: envInteger("PORT", 62774, { min: 1, max: 65535 }),
  apiKey: process.env.BRIDGE_API_KEY ?? "",
  chromeExecutablePath: resolveOptionalPath(
    process.env.CHROME_EXECUTABLE_PATH ??
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      ""
  ),
  browserProfileDir: process.env.BROWSER_PROFILE_DIR
    ? path.resolve(process.env.BROWSER_PROFILE_DIR)
    : path.join(cwd, ".browser-profile"),
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(cwd, ".data"),
  databaseUrl: process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "",
  pixelvaultApiUrl:
    process.env.PIXELVAULT_API_URL ?? "https://api.pixelvault.dev/v1/images",
  pixelvaultApiKey: process.env.PIXELVAULT_API_KEY ?? "",
  pixelvaultExpiration: process.env.PIXELVAULT_EXPIRATION ?? "",
  grokBaseUrl: process.env.GROK_BASE_URL ?? "https://grok.com",
  grokCookieFile: resolveOptionalPath(process.env.GROK_COOKIE_FILE ?? ""),
  grokCookiesText: process.env.GROK_COOKIES_TEXT ?? "",
  grokEmail: process.env.GROK_EMAIL ?? "",
  grokPassword: process.env.GROK_PASSWORD ?? "",
  headless: envBool("HEADLESS", true),
  importCookiesOnBoot: envBool("IMPORT_COOKIES_ON_BOOT", true),
  browserNetworkIdleTimeoutMs: envInteger("BROWSER_NETWORK_IDLE_TIMEOUT_MS", 1000),
  browserPageLoadDelayMs: envInteger("BROWSER_PAGE_LOAD_DELAY_MS", 1000),
  browserStreamBatchMaxChars: envInteger("BROWSER_STREAM_BATCH_MAX_CHARS", 16384, { min: 1 }),
  browserStreamBatchDelayMs: envInteger("BROWSER_STREAM_BATCH_DELAY_MS", 2),
  browserStatsigMaxAttempts: envInteger("BROWSER_STATSIG_MAX_ATTEMPTS", 600, { min: 1 }),
  browserStatsigRetryDelayMs: envInteger("BROWSER_STATSIG_RETRY_DELAY_MS", 150, { min: 1 }),
  browserRequestTimeoutMs: envInteger("BROWSER_REQUEST_TIMEOUT_MS", 10 * 60 * 1000, { min: 1 }),
  fallbackMaxTotalMs: envInteger("FALLBACK_MAX_TOTAL_MS", 120000, { min: 1 }),
  shutdownTimeoutMs: envInteger("SHUTDOWN_TIMEOUT_MS", 30 * 1000, { min: 1 }),
  fileUploadConcurrency: envInteger("FILE_UPLOAD_CONCURRENCY", 4, { min: 1 }),
  responseHydrationDelaysMs: process.env.RESPONSE_HYDRATION_DELAYS_MS
    ? process.env.RESPONSE_HYDRATION_DELAYS_MS.split(",").map(Number).filter(Number.isFinite)
    : null,
  responseHydrationThinkingDelaysMs: process.env.RESPONSE_HYDRATION_THINKING_DELAYS_MS
    ? process.env.RESPONSE_HYDRATION_THINKING_DELAYS_MS.split(",").map(Number).filter(Number.isFinite)
    : null,
  defaultModel: process.env.DEFAULT_MODEL ?? "grok-4.6-auto",
  defaultMode: process.env.DEFAULT_MODE ?? "auto",
  allowOrigins: process.env.ALLOW_ORIGINS ?? "*",
  verbose: envBool("VERBOSE", false)
};
