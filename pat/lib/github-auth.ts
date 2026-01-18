import { unsealCookieValue } from "@/lib/secure-cookie";

const TOKEN_COOKIE = "pat_github_token";

function parseCookieHeader(cookieHeader: string | null) {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

export function getGitHubTokenFromRequest(req: Request) {
  const cookies = parseCookieHeader(req.headers.get("cookie"));
  const sealed = cookies[TOKEN_COOKIE];
  if (!sealed) return null;
  return unsealCookieValue(sealed);
}

export function getGitHubTokenCookieName() {
  return TOKEN_COOKIE;
}

