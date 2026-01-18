import { getGitHubTokenFromRequest } from "@/lib/github-auth";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

function decodeBase64(text: string) {
  return Buffer.from(text.replace(/\s/g, ""), "base64").toString("utf8");
}

function encodeRepoPath(repoPath: string) {
  return repoPath
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
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
  const path = typeof body.path === "string" ? body.path : "";
  const ref = typeof body.ref === "string" ? body.ref : "";

  if (!owner || !repo || !path) {
    return json({ ok: false, error: "Missing owner/repo/path." }, { status: 400 });
  }

  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeRepoPath(path)}`);
  if (ref) url.searchParams.set("ref", ref);

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
  if (!isRecord(data)) return json({ ok: false, error: "Unexpected GitHub response." }, { status: 502 });

  if (data.type !== "file") {
    return json({ ok: false, error: "Path is not a file." }, { status: 400 });
  }

  const content = data.content;
  const encoding = data.encoding;
  const size = typeof data.size === "number" ? data.size : null;

  if (encoding !== "base64" || typeof content !== "string") {
    return json({ ok: false, error: "Unsupported file encoding." }, { status: 502 });
  }

  const maxCharsEnv = Number(process.env.GITHUB_MAX_CHARS ?? "60000");
  const maxChars = Number.isFinite(maxCharsEnv) ? Math.min(Math.max(maxCharsEnv, 2000), 200000) : 60000;

  const text = decodeBase64(content);
  if (text.length > maxChars) {
    return json(
      {
        ok: false,
        error: `File too large to attach (${text.length} chars). Increase GITHUB_MAX_CHARS or ask for a smaller section.`,
        size,
      },
      { status: 413 },
    );
  }

  return json({
    ok: true,
    owner,
    repo,
    path,
    ref: ref || null,
    size,
    content: text,
  });
}
