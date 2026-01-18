import { getGitHubTokenFromRequest } from "@/lib/github-auth";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

export async function GET(req: Request) {
  const token = getGitHubTokenFromRequest(req);
  if (!token) return json({ ok: true, connected: false });

  const upstream = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "Pat",
    },
  });

  if (!upstream.ok) {
    return json({ ok: true, connected: false });
  }

  const data = (await upstream.json().catch(() => null)) as unknown;
  if (!isRecord(data) || typeof data.login !== "string") {
    return json({ ok: true, connected: false });
  }

  return json({ ok: true, connected: true, login: data.login });
}

