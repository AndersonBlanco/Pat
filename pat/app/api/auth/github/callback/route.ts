import { cookies } from "next/headers";
import { sealCookieValue } from "@/lib/secure-cookie";
import { getGitHubTokenCookieName } from "@/lib/github-auth";

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

type TokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

export async function GET(req: Request) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const sessionSecret = process.env.PAT_SESSION_SECRET;

  if (!clientId || !clientSecret) {
    return json(
      { ok: false, error: "Missing GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET in pat/.env.local." },
      { status: 500 },
    );
  }

  if (!sessionSecret) {
    return json({ ok: false, error: "Missing PAT_SESSION_SECRET in pat/.env.local." }, { status: 500 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!code || !state) {
    return json({ ok: false, error: "Missing code/state." }, { status: 400 });
  }

  const origin = process.env.APP_URL?.trim() || url.origin;
  const jar = await cookies();
  const expected = jar.get("pat_github_oauth_state")?.value || "";
  jar.delete("pat_github_oauth_state");

  if (!expected || expected !== state) {
    return json({ ok: false, error: "Invalid OAuth state." }, { status: 400 });
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  const tokenJson = (await tokenRes.json().catch(() => null)) as TokenResponse | null;
  if (!tokenRes.ok || !tokenJson) {
    return json({ ok: false, error: "GitHub token exchange failed." }, { status: 502 });
  }
  if (tokenJson.error) {
    return json(
      { ok: false, error: tokenJson.error_description || tokenJson.error },
      { status: 400 },
    );
  }

  const token = tokenJson.access_token;
  if (!token) return json({ ok: false, error: "Missing access_token." }, { status: 502 });

  const sealed = sealCookieValue(token);
  const cookieName = getGitHubTokenCookieName();

  jar.set(cookieName, sealed, {
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https://"),
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });

  return Response.redirect(`${origin}/settings?github=connected`, 302);
}

