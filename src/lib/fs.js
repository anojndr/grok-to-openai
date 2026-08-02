import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJson(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

export async function writeJson(filePath, value) {
  const directory = path.dirname(filePath);
  const serialized = `${JSON.stringify(value)}\n`;
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );

  await ensureDir(directory);

  let tempFile;
  try {
    tempFile = await fs.open(tempPath, "wx");
    await tempFile.writeFile(serialized, "utf8");
    await tempFile.sync();
    await tempFile.close();
    tempFile = null;
    await fs.rename(tempPath, filePath);

    let directoryHandle;
    try {
      directoryHandle = await fs.open(directory, "r");
      await directoryHandle.sync();
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF"].includes(error?.code)) {
        throw error;
      }
    } finally {
      await directoryHandle?.close().catch(() => {});
    }
  } catch (error) {
    await tempFile?.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function sanitizeFilename(name) {
  return name.replace(/[^\w.-]+/g, "_");
}
