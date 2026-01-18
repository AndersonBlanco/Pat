import crypto from "node:crypto";
import { cookies } from "next/headers";

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

export async function GET(req: Request) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return json(
      { ok: false, error: "Missing GITHUB_CLIENT_ID. Set it in pat/.env.local." },
      { status: 500 },
    );
  }

  const origin = process.env.APP_URL?.trim() || new URL(req.url).origin;
  const redirectUri = `${origin}/api/auth/github/callback`;

  const state = crypto.randomBytes(16).toString("hex");
  const jar = await cookies();
  jar.set("pat_github_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https://"),
    path: "/",
    maxAge: 10 * 60,
  });

  const scope = "read:user repo";
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);

  return Response.redirect(url.toString(), 302);
}

