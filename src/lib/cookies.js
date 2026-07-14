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

      const [domain, includeSubdomains, path, secure, expires, name, ...rest] = parts;
      const value = rest.join("\t");
      const normalizedDomain = parseBoolean(includeSubdomains) && !domain.startsWith(".")
        ? `.${domain}`
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
  let currentCookies = [];
  const currentKeys = new Set();

  const flush = () => {
    if (currentCookies.length) {
      groups.push(currentCookies);
    }
    currentCookies = [];
    currentKeys.clear();
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    const isHeader = trimmed.startsWith("#") && /netscape|http cookie/i.test(trimmed);
    if (isHeader && currentCookies.length > 0) {
      flush();
    }

    if (trimmed.startsWith("#")) {
      continue;
    }

    const parsedList = parseNetscapeCookieText(rawLine);
    if (parsedList && parsedList.length > 0) {
      const cookie = parsedList[0];
      const key = `${cookie.domain}:${cookie.name}:${cookie.path}`;

      if (currentKeys.has(key)) {
        flush();
      }

      currentCookies.push(cookie);
      currentKeys.add(key);
    }
  }

  flush();

  return groups;
}

function parseMultipleJson(text) {
  const results = [];
  let index = 0;

  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) {
      index++;
    }
    if (index >= text.length) {
      break;
    }

    if (text[index] !== "[" && text[index] !== "{") {
      const nextStart = text.slice(index).search(/[\[{]/);
      if (nextStart === -1) {
        break;
      }
      index += nextStart;
    }

    const startChar = text[index];
    const endChar = startChar === "[" ? "]" : "}";
    let depth = 0;
    let inString = false;
    let escaped = false;
    let foundEnd = false;
    let i = index;

    for (; i < text.length; i++) {
      const char = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === startChar) {
          depth++;
        } else if (char === endChar) {
          depth--;
          if (depth === 0) {
            foundEnd = true;
            i++;
            break;
          }
        }
      }
    }

    if (foundEnd) {
      const jsonStr = text.slice(index, i);
      try {
        const parsed = JSON.parse(jsonStr);
        results.push(parsed);
        index = i;
      } catch (e) {
        index++;
      }
    } else {
      break;
    }
  }

  return results.length ? results : null;
}

function normalizeParsedCookieJson(parsed) {
  if (!parsed) {
    return null;
  }

  const isCookie = (obj) =>
    obj && typeof obj === "object" && "name" in obj && "value" in obj && !("cookies" in obj);

  const getCookiesFromAccount = (acc) => {
    if (Array.isArray(acc)) {
      return acc;
    }
    if (acc && typeof acc === "object") {
      if (Array.isArray(acc.cookies)) {
        return acc.cookies;
      }
    }
    return null;
  };

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return [];
    }

    if (Array.isArray(parsed[0])) {
      return parsed.map(getCookiesFromAccount).filter(Boolean);
    }

    if (parsed.every(isCookie)) {
      return [parsed];
    }

    const accountsCookies = parsed.map(getCookiesFromAccount).filter(Boolean);
    if (accountsCookies.length > 0) {
      return accountsCookies;
    }

    return [parsed];
  }

  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.cookies)) {
      return [parsed.cookies];
    }
    if (Array.isArray(parsed.accounts)) {
      return parsed.accounts.map(getCookiesFromAccount).filter(Boolean);
    }
  }

  return null;
}

export function parseCookieJson(text) {
  try {
    const trimmed = text.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
      return null;
    }

    const parsedDocs = parseMultipleJson(trimmed);
    if (!parsedDocs) {
      return null;
    }

    const allAccounts = [];
    for (const doc of parsedDocs) {
      const normalized = normalizeParsedCookieJson(doc);
      if (normalized) {
        allAccounts.push(...normalized);
      }
    }

    return allAccounts;
  } catch (e) {
    return null;
  }
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

  const jsonGroups = parseCookieJson(content);
  if (jsonGroups) {
    return jsonGroups;
  }

  return parseNetscapeCookieTextGroups(content);
}

export async function readCookiesFromSource({ filePath = "", rawText = "" }) {
  const groups = await readCookieSetsFromSource({ filePath, rawText });
  return groups[0] ?? [];
}

