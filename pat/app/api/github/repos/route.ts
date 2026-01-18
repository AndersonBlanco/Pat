import { getGitHubTokenFromRequest } from "@/lib/github-auth";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

type Repo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  owner: { login: string };
};

export async function GET(req: Request) {
  const token = getGitHubTokenFromRequest(req);
  if (!token) return json({ ok: false, error: "Not connected to GitHub." }, { status: 401 });

  const url = new URL(req.url);
  const visibility = url.searchParams.get("visibility") || "all";
  const perPage = 100;

  const repos: Array<{
    id: number;
    owner: string;
    name: string;
    fullName: string;
    private: boolean;
    defaultBranch: string;
  }> = [];

  for (let page = 1; page <= 5; page += 1) {
    const upstreamUrl = new URL("https://api.github.com/user/repos");
    upstreamUrl.searchParams.set("per_page", String(perPage));
    upstreamUrl.searchParams.set("page", String(page));
    upstreamUrl.searchParams.set("sort", "updated");
    upstreamUrl.searchParams.set("visibility", visibility);

    const upstream = await fetch(upstreamUrl.toString(), {
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
    if (!Array.isArray(data)) break;

    const batch: Repo[] = [];
    for (const item of data) {
      if (!isRecord(item)) continue;
      if (typeof item.id !== "number") continue;
      if (typeof item.name !== "string") continue;
      if (typeof item.full_name !== "string") continue;
      if (typeof item.private !== "boolean") continue;
      if (typeof item.default_branch !== "string") continue;
      if (!isRecord(item.owner) || typeof item.owner.login !== "string") continue;
      batch.push(item as unknown as Repo);
    }

    for (const r of batch) {
      repos.push({
        id: r.id,
        owner: r.owner.login,
        name: r.name,
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
      });
    }

    if (data.length < perPage) break;
  }

  return json({ ok: true, repos });
}

