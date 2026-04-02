import crypto from "node:crypto";

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function unixTimestampSeconds(date = new Date()) {
  return Math.floor(date.getTime() / 1000);
}
