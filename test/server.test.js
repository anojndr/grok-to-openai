import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine free port"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForHealthy(baseUrl, child) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 15000) {
    if (child.exitCode != null) {
      throw new Error(`Server exited before becoming healthy with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for the server to become healthy");
}

async function startServer() {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "grok-to-openai-server-")
  );
  const port = await getFreePort();
  let output = "";
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      BRIDGE_API_KEY: "",
      HEADLESS: "1",
      IMPORT_COOKIES_ON_BOOT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitForHealthy(`http://127.0.0.1:${port}`, child);
  } catch (error) {
    if (child.exitCode == null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await fs.rm(dataDir, { recursive: true, force: true });
    throw new Error(`${error.message}\n\nServer output:\n${output}`);
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    dataDir
  };
}

async function stopServer({ child, dataDir }) {
  if (child.exitCode == null) {
    const exitPromise = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  }

  if (child.exitCode == null) {
    const exitPromise = once(child, "exit");
    child.kill("SIGKILL");
    await exitPromise;
  }

  await fs.rm(dataDir, { recursive: true, force: true });
}

test("server rejects oversized JSON bodies with guidance to use /v1/files and file_id", async () => {
  const server = await startServer();

  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        input: [],
        instructions: "x".repeat(16 * 1024 * 1024)
      })
    });

    assert.equal(response.status, 413);

    const payload = await response.json();
    assert.match(payload.error.message, /\/v1\/files/);
    assert.match(payload.error.message, /file_id/);
  } finally {
    await stopServer(server);
  }
});
