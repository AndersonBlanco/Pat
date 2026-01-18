import crypto from "node:crypto";

function base64UrlEncode(buf: Buffer) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(text: string) {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${pad}`, "base64");
}

function getKey() {
  const secret = process.env.PAT_SESSION_SECRET;
  if (!secret) {
    throw new Error("Missing PAT_SESSION_SECRET.");
  }
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

export function sealCookieValue(value: string) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${base64UrlEncode(iv)}.${base64UrlEncode(tag)}.${base64UrlEncode(ciphertext)}`;
}

export function unsealCookieValue(sealed: string) {
  const parts = sealed.split(".");
  if (parts.length !== 3) return null;
  const [ivB64, tagB64, cipherB64] = parts;
  try {
    const key = getKey();
    const iv = base64UrlDecode(ivB64);
    const tag = base64UrlDecode(tagB64);
    const ciphertext = base64UrlDecode(cipherB64);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}

