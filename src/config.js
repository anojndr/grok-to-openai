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

function resolveOptionalPath(value) {
  if (!value) {
    return "";
  }

  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? "8787"),
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
  grokBaseUrl: process.env.GROK_BASE_URL ?? "https://grok.com",
  grokCookieFile: resolveOptionalPath(process.env.GROK_COOKIE_FILE ?? ""),
  grokCookiesText: process.env.GROK_COOKIES_TEXT ?? "",
  grokEmail: process.env.GROK_EMAIL ?? "",
  grokPassword: process.env.GROK_PASSWORD ?? "",
  headless: envBool("HEADLESS", true),
  importCookiesOnBoot: envBool("IMPORT_COOKIES_ON_BOOT", true),
  defaultModel: process.env.DEFAULT_MODEL ?? "grok-4-auto",
  defaultMode: process.env.DEFAULT_MODE ?? "auto",
  allowOrigins: process.env.ALLOW_ORIGINS ?? "*"
};
