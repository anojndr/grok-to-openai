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

export async function readCookiesFromSource({ filePath = "", rawText = "" }) {
  if (rawText.trim()) {
    return parseNetscapeCookieText(rawText);
  }

  if (filePath) {
    const content = await fs.readFile(filePath, "utf8");
    return parseNetscapeCookieText(content);
  }

  return [];
}
