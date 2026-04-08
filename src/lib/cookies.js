import fs from "node:fs/promises";

function parseBoolean(value) {
  return String(value).toUpperCase() === "TRUE";
}

export function parseNetscapeCookieText(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length < 7) {
        return null;
      }

      const [domain, , path, secure, expires, name, ...rest] = parts;
      const value = rest.join("\t");
      const normalizedDomain = domain.startsWith(".")
        ? domain.slice(1)
        : domain;

      return {
        name,
        value,
        domain: normalizedDomain,
        path,
        secure: parseBoolean(secure),
        httpOnly: false,
        expires: expires === "0" ? -1 : Number(expires)
      };
    })
    .filter(Boolean);
}

export function parseNetscapeCookieTextGroups(text) {
  const lines = text.split(/\r?\n/);
  const groups = [];
  let currentLines = [];
  let sawCookieLine = false;

  const flush = () => {
    if (!currentLines.length) {
      return;
    }

    const cookies = parseNetscapeCookieText(currentLines.join("\n"));
    if (cookies.length) {
      groups.push(cookies);
    }

    currentLines = [];
    sawCookieLine = false;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const isHeader = trimmed === "# Netscape HTTP Cookie File";
    const isCookieLine = Boolean(trimmed) && !trimmed.startsWith("#");

    if (isHeader && sawCookieLine) {
      flush();
    }

    currentLines.push(rawLine);

    if (isCookieLine) {
      sawCookieLine = true;
    }
  }

  flush();

  return groups;
}

async function readCookieSourceText({ filePath = "", rawText = "" }) {
  if (rawText.trim()) {
    return rawText;
  }

  if (filePath) {
    return fs.readFile(filePath, "utf8");
  }

  return "";
}

export async function readCookieSetsFromSource({ filePath = "", rawText = "" }) {
  const content = await readCookieSourceText({ filePath, rawText });
  if (!content.trim()) {
    return [];
  }

  return parseNetscapeCookieTextGroups(content);
}

export async function readCookiesFromSource({ filePath = "", rawText = "" }) {
  const groups = await readCookieSetsFromSource({ filePath, rawText });
  return groups[0] ?? [];
}
