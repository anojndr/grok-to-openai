import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const restartScriptPath = path.resolve(__dirname, "../restart.sh");

function runScript(args = [], options = {}) {
  return new Promise((resolve) => {
    execFile(restartScriptPath, args, options, (error, stdout, stderr) => {
      resolve({
        code: error ? error.code ?? 1 : 0,
        stdout,
        stderr
      });
    });
  });
}

function runBashModeExtraction(args = []) {
  return new Promise((resolve, reject) => {
    const cmd = `
      set -euo pipefail
      MODE="not_set"
      # extract argument parsing loop from restart.sh
      eval "$(sed -n '/^MODE=/,/^done/p' "${restartScriptPath}")"
      echo "$MODE"
    `;
    execFile("bash", ["-c", cmd, "bash", ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Bash error (${error.code}): ${stderr}\n${stdout}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

test("restart.sh --help displays usage with default background and foreground option", async () => {
  const result = await runScript(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /\.\/restart\.sh.*background/i);
  assert.match(result.stdout, /--foreground/);
});

test("restart.sh -h displays usage with foreground option", async () => {
  const result = await runScript(["-h"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--foreground/);
});

test("restart.sh rejects unknown options with usage details", async () => {
  const result = await runScript(["--unknown-flag"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option: --unknown-flag/);
  assert.match(result.stderr, /--foreground/);
  assert.match(result.stderr, /--background/);
});

test("restart.sh defaults MODE to background when no arguments are passed", async () => {
  const mode = await runBashModeExtraction([]);
  assert.equal(mode, "background");
});

test("restart.sh sets MODE to background with --background or -b", async () => {
  const modeLong = await runBashModeExtraction(["--background"]);
  assert.equal(modeLong, "background");
  const modeShort = await runBashModeExtraction(["-b"]);
  assert.equal(modeShort, "background");
});

test("restart.sh sets MODE to foreground with --foreground or -f", async () => {
  const modeLong = await runBashModeExtraction(["--foreground"]);
  assert.equal(modeLong, "foreground");
  const modeShort = await runBashModeExtraction(["-f"]);
  assert.equal(modeShort, "foreground");
});
