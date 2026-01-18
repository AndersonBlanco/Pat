import { getGitHubTokenFromRequest } from "@/lib/github-auth";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

export async function POST(req: Request) {
  const token = getGitHubTokenFromRequest(req);
  if (!token) return json({ ok: false, error: "Not connected to GitHub." }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isRecord(body)) return json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  const owner = typeof body.owner === "string" ? body.owner : "";
  const repo = typeof body.repo === "string" ? body.repo : "";
  const query = typeof body.query === "string" ? body.query : "";

  if (!owner || !repo || !query.trim()) {
    return json({ ok: false, error: "Missing owner/repo/query." }, { status: 400 });
  }

  const q = `${query} repo:${owner}/${repo}`;
  const url = new URL("https://api.github.com/search/code");
  url.searchParams.set("q", q);
  url.searchParams.set("per_page", "10");

  const upstream = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "Pat",
    },
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return json({ ok: false, error: `GitHub error (${upstream.status}). ${text}` }, { status: 502 });
  }

  const data = (await upstream.json().catch(() => null)) as unknown;
  if (!isRecord(data) || !Array.isArray(data.items)) {
    return json({ ok: false, error: "Unexpected GitHub response." }, { status: 502 });
  }

  const results: Array<{ path: string; repository: string; htmlUrl: string }> = [];
  for (const item of data.items) {
    if (!isRecord(item)) continue;
    if (typeof item.path !== "string") continue;
    if (!isRecord(item.repository) || typeof item.repository.full_name !== "string") continue;
    const htmlUrl = typeof item.html_url === "string" ? item.html_url : "";
    results.push({ path: item.path, repository: item.repository.full_name, htmlUrl });
  }

  return json({ ok: true, results });
}

