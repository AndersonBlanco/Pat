import { clampNumber, firecrawlScrapeMarkdown } from "@/lib/firecrawl";
import { getGitHubTokenFromRequest } from "@/lib/github-auth";
export const dynamic = "force-dynamic";

type Role = "system" | "user" | "assistant";
type ToolCall =
  | { name: "firecrawl_scrape"; arguments: { url: string } }
  | { name: "github_repos"; arguments: { query?: string } }
  | { name: "github_search"; arguments: { query: string } }
  | { name: "github_read"; arguments: { path: string } }
  | { name: "github_list"; arguments: { path: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

function extractFirstContent(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const choices = data.choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;

  const message = first.message;
  if (isRecord(message) && typeof message.content === "string") return message.content;

  const delta = first.delta;
  if (isRecord(delta) && typeof delta.content === "string") return delta.content;

  return null;
}

function unwrapJsonCandidate(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function parseToolCallFromContent(content: string): ToolCall | null {
  const candidate = unwrapJsonCandidate(content);
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  const jsonText = candidate.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (parsed.type !== "tool_call") return null;

  const name = parsed.name;
  if (typeof name !== "string") return null;
  if (!isRecord(parsed.arguments)) return null;

  if (name === "firecrawl_scrape" || name === "firecrawl.scrape") {
    const url = parsed.arguments.url;
    if (typeof url !== "string" || !url.trim()) return null;
    return { name: "firecrawl_scrape", arguments: { url: url.trim() } };
  }

  if (name === "github_repos" || name === "github.repos") {
    const query = parsed.arguments.query;
    if (typeof query === "string" && query.trim()) {
      return { name: "github_repos", arguments: { query: query.trim() } };
    }
    return { name: "github_repos", arguments: {} };
  }

  if (name === "github_search" || name === "github.search") {
    const query = parsed.arguments.query;
    if (typeof query !== "string" || !query.trim()) return null;
    return { name: "github_search", arguments: { query: query.trim() } };
  }

  if (name === "github_read" || name === "github.read") {
    const path = parsed.arguments.path;
    if (typeof path !== "string" || !path.trim()) return null;
    return { name: "github_read", arguments: { path: path.trim() } };
  }

  if (name === "github_list" || name === "github.list") {
    const path = parsed.arguments.path;
    if (typeof path === "string") return { name: "github_list", arguments: { path: path.trim() } };
    return { name: "github_list", arguments: { path: "" } };
  }

  return null;
}

function injectToolInstructions(
  messages: Array<{ role: Role; content: string }>,
  opts: {
    firecrawl: boolean;
    github: boolean;
    githubRepo?: { owner: string; repo: string; ref: string };
  },
) {
  const lines: string[] = ["Tooling available:"];
  if (opts.firecrawl) {
    lines.push("- firecrawl_scrape(url): Fetches a public web page and returns main-content markdown.");
  }
  if (opts.github && opts.githubRepo) {
    const ref = opts.githubRepo.ref ? `@${opts.githubRepo.ref}` : "";
    lines.push("- github_repos(query?): Lists repos you can access for the connected GitHub account.");
    lines.push(
      `- github_search(query): Code search in ${opts.githubRepo.owner}/${opts.githubRepo.repo}${ref}.`,
    );
    lines.push(
      `- github_list(path): Lists files/folders in ${opts.githubRepo.owner}/${opts.githubRepo.repo}${ref} at repo-relative path (use "" for root).`,
    );
    lines.push(
      `- github_read(path): Reads a file from ${opts.githubRepo.owner}/${opts.githubRepo.repo}${ref} by repo-relative path.`,
    );
  } else if (opts.github) {
    lines.push("- github_repos(query?): Lists repos you can access for the connected GitHub account.");
  }

  const examples: string[] = [];
  if (opts.firecrawl) {
    examples.push('{"type":"tool_call","name":"firecrawl_scrape","arguments":{"url":"https://example.com"}}');
  }
  if (opts.github) {
    examples.push('{"type":"tool_call","name":"github_repos","arguments":{}}');
    examples.push('{"type":"tool_call","name":"github_search","arguments":{"query":"auth middleware"}}');
    examples.push('{"type":"tool_call","name":"github_list","arguments":{"path":""}}');
    examples.push('{"type":"tool_call","name":"github_read","arguments":{"path":"src/app.ts"}}');
  }

  const toolHelp =
    `${lines.join("\n")}\n\n` +
    "If you need a tool, respond with exactly one line of JSON and nothing else:\n" +
    `${examples.join("\n")}\n\n` +
    "After you receive the tool result, answer normally.";

  if (messages.length && messages[0]?.role === "system") {
    messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${toolHelp}` };
    return;
  }

  messages.unshift({ role: "system", content: toolHelp });
}

async function githubSearch(options: {
  token: string;
  owner: string;
  repo: string;
  query: string;
}) {
  const q = `${options.query} repo:${options.owner}/${options.repo}`;
  const url = new URL("https://api.github.com/search/code");
  url.searchParams.set("q", q);
  url.searchParams.set("per_page", "10");

  const upstream = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${options.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "Pat",
    },
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    throw new Error(`GitHub error (${upstream.status}). ${text}`);
  }

  const data = (await upstream.json().catch(() => null)) as unknown;
  if (!isRecord(data) || !Array.isArray(data.items)) throw new Error("Unexpected GitHub response.");

  const results: Array<{ path: string; htmlUrl: string }> = [];
  for (const item of data.items) {
    if (!isRecord(item)) continue;
    if (typeof item.path !== "string") continue;
    const htmlUrl = typeof item.html_url === "string" ? item.html_url : "";
    results.push({ path: item.path, htmlUrl });
  }
  return results;
}

async function githubRead(options: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  ref?: string;
  maxChars: number;
}) {
  const encodedPath = options.path
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
  const url = new URL(
    `https://api.github.com/repos/${options.owner}/${options.repo}/contents/${encodedPath}`,
  );
  if (options.ref) url.searchParams.set("ref", options.ref);

  const upstream = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${options.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "Pat",
    },
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    throw new Error(`GitHub error (${upstream.status}). ${text}`);
  }

  const data = (await upstream.json().catch(() => null)) as unknown;
  if (!isRecord(data)) throw new Error("Unexpected GitHub response.");
  if (data.type !== "file") throw new Error("Path is not a file.");
  if (data.encoding !== "base64" || typeof data.content !== "string") {
    throw new Error("Unsupported file encoding.");
  }

  const text = Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8");
  if (text.length > options.maxChars) {
    throw new Error(`File too large to attach (${text.length} chars).`);
  }
  return text;
}

async function githubRepos(options: {
  token: string;
  query?: string;
  maxItems: number;
}) {
  const perPage = 100;
  const items: Array<{
    id: number;
    owner: string;
    name: string;
    fullName: string;
    private: boolean;
    defaultBranch: string;
  }> = [];

  for (let page = 1; page <= 5; page += 1) {
    const url = new URL("https://api.github.com/user/repos");
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "updated");
    url.searchParams.set("visibility", "all");

    const upstream = await fetch(url.toString(), {
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/vnd.github+json",
        "user-agent": "Pat",
      },
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      throw new Error(`GitHub error (${upstream.status}). ${text}`);
    }

    const data = (await upstream.json().catch(() => null)) as unknown;
    if (!Array.isArray(data)) break;

    for (const entry of data) {
      if (!isRecord(entry)) continue;
      if (typeof entry.id !== "number") continue;
      if (typeof entry.name !== "string") continue;
      if (typeof entry.full_name !== "string") continue;
      if (typeof entry.private !== "boolean") continue;
      if (typeof entry.default_branch !== "string") continue;
      if (!isRecord(entry.owner) || typeof entry.owner.login !== "string") continue;

      items.push({
        id: entry.id,
        owner: entry.owner.login,
        name: entry.name,
        fullName: entry.full_name,
        private: entry.private,
        defaultBranch: entry.default_branch,
      });

      if (items.length >= options.maxItems) break;
    }

    if (items.length >= options.maxItems) break;
    if (data.length < perPage) break;
  }

  const query = options.query?.trim().toLowerCase();
  const filtered = query
    ? items.filter((r) => r.fullName.toLowerCase().includes(query) || r.name.toLowerCase().includes(query))
    : items;

  return filtered.slice(0, options.maxItems);
}

async function githubList(options: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  ref?: string;
  maxItems: number;
}) {
  const cleanPath = options.path.replace(/^\/+/, "");
  const encodedPath = cleanPath
    ? cleanPath
        .split("/")
        .filter(Boolean)
        .map((p) => encodeURIComponent(p))
        .join("/")
    : "";

  const url = new URL(
    `https://api.github.com/repos/${options.owner}/${options.repo}/contents${encodedPath ? `/${encodedPath}` : ""}`,
  );
  if (options.ref) url.searchParams.set("ref", options.ref);

  const upstream = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${options.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "Pat",
    },
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    throw new Error(`GitHub error (${upstream.status}). ${text}`);
  }

  const data = (await upstream.json().catch(() => null)) as unknown;
  if (!data) throw new Error("Unexpected GitHub response.");

  type Item = { type: "file" | "dir" | "symlink" | "submodule" | "unknown"; path: string; size: number | null };

  const items: Item[] = [];

  if (Array.isArray(data)) {
    for (const entry of data) {
      if (!isRecord(entry)) continue;
      const type = typeof entry.type === "string" ? entry.type : "unknown";
      const path = typeof entry.path === "string" ? entry.path : "";
      const size = typeof entry.size === "number" ? entry.size : null;
      if (!path) continue;
      items.push({
        type:
          type === "file" || type === "dir" || type === "symlink" || type === "submodule"
            ? type
            : "unknown",
        path,
        size,
      });
    }
  } else if (isRecord(data)) {
    const type = typeof data.type === "string" ? data.type : "unknown";
    const path = typeof data.path === "string" ? data.path : cleanPath;
    const size = typeof data.size === "number" ? data.size : null;
    if (!path) throw new Error("Unexpected GitHub response.");
    items.push({
      type:
        type === "file" || type === "dir" || type === "symlink" || type === "submodule"
          ? type
          : "unknown",
      path,
      size,
    });
  } else {
    throw new Error("Unexpected GitHub response.");
  }

  const limited = items.slice(0, options.maxItems);
  return { items: limited, total: items.length };
}

async function callXai(options: {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  messages: Array<{ role: Role; content: string }>;
  extraBody?: Record<string, unknown>;
}) {
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      ...(options.extraBody ?? {}),
    }),
  });
}

export async function POST(req: Request) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return json(
      { ok: false, error: "Missing XAI_API_KEY. Set it in pat/.env.local." },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isRecord(body)) {
    return json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const model = typeof body.model === "string" ? body.model : "grok-3";
  const temperature = typeof body.temperature === "number" ? body.temperature : 0.3;
  const messages = Array.isArray(body.messages) ? body.messages : null;
  const tools = isRecord(body.tools) ? body.tools : null;
  const firecrawlToolEnabled = tools ? tools.firecrawl === true : false;
  const githubToolEnabled = tools ? tools.github === true : false;
  const githubRepoRaw = tools ? tools.githubRepo : null;
  const githubRepo =
    githubToolEnabled &&
    isRecord(githubRepoRaw) &&
    typeof githubRepoRaw.owner === "string" &&
    typeof githubRepoRaw.repo === "string"
      ? {
          owner: githubRepoRaw.owner,
          repo: githubRepoRaw.repo,
          ref: typeof githubRepoRaw.ref === "string" ? githubRepoRaw.ref : "",
        }
      : null;

  if (!messages) {
    return json({ ok: false, error: "`messages` must be an array." }, { status: 400 });
  }

  const wireMessages = messages
    .map((m: unknown) => {
      if (!isRecord(m)) return null;
      const role = m.role as Role | undefined;
      const content = m.content;
      if (
        (role !== "system" && role !== "user" && role !== "assistant") ||
        typeof content !== "string" ||
        !content.trim()
      ) {
        return null;
      }
      return { role, content };
    })
    .filter(Boolean);

  if (!wireMessages.length) {
    return json({ ok: false, error: "No valid messages provided." }, { status: 400 });
  }

  const baseUrl = process.env.XAI_BASE_URL?.trim() || "https://api.x.ai/v1";

  const preparedMessages = wireMessages.slice() as Array<{ role: Role; content: string }>;
  if (firecrawlToolEnabled || githubToolEnabled) {
    injectToolInstructions(preparedMessages, { firecrawl: firecrawlToolEnabled, github: githubToolEnabled, githubRepo: githubRepo ?? undefined });
  }

  const upstream = await callXai({
    apiKey,
    baseUrl,
    model,
    temperature,
    messages: preparedMessages,
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return json(
      {
        ok: false,
        error: `xAI error (${upstream.status}). ${text || "No response body."}`,
      },
      { status: 502 },
    );
  }

  const data = (await upstream.json()) as unknown;
  const content = extractFirstContent(data);

  if (typeof content !== "string" || !content.trim()) {
    return json(
      { ok: false, error: "Unexpected xAI response format (missing content)." },
      { status: 502 },
    );
  }

  const toolCall = parseToolCallFromContent(content);
  if (toolCall) {
    if (toolCall.name === "firecrawl_scrape") {
      const firecrawlKey = process.env.FIRECRAWL_API_KEY;
      if (!firecrawlKey) {
        return json(
          { ok: false, error: "Missing FIRECRAWL_API_KEY. Set it in pat/.env.local." },
          { status: 500 },
        );
      }

      const base = process.env.FIRECRAWL_BASE_URL?.trim() || undefined;
      const maxCharsEnv = Number(process.env.FIRECRAWL_MAX_CHARS ?? "20000");
      const maxChars = clampNumber(
        Number.isNaN(maxCharsEnv) ? 20000 : maxCharsEnv,
        1000,
        200000,
      );

      let scraped: { url: string; markdown: string };
      try {
        scraped = await firecrawlScrapeMarkdown({
          apiKey: firecrawlKey,
          url: toolCall.arguments.url,
          baseUrl: base,
          onlyMainContent: true,
          maxChars,
        });
      } catch (e) {
        return json(
          { ok: false, error: e instanceof Error ? e.message : "Scrape failed." },
          { status: 502 },
        );
      }

      const toolResultSystem = {
        role: "system" as const,
        content: `Tool result (firecrawl_scrape)\nURL: ${scraped.url}\n\n${scraped.markdown}`,
      };

      const followUpMessages = [
        ...preparedMessages,
        { role: "assistant" as const, content },
        toolResultSystem,
      ];

      const upstream2 = await callXai({
        apiKey,
        baseUrl,
        model,
        temperature,
        messages: followUpMessages,
      });

      if (!upstream2.ok) {
        const text = await upstream2.text().catch(() => "");
        return json(
          { ok: false, error: `xAI error (${upstream2.status}). ${text || "No response body."}` },
          { status: 502 },
        );
      }

      const data2 = (await upstream2.json()) as unknown;
      const content2 = extractFirstContent(data2);
      if (typeof content2 !== "string" || !content2.trim()) {
        return json(
          { ok: false, error: "Unexpected xAI response format (missing content)." },
          { status: 502 },
        );
      }

      return json({ ok: true, message: { role: "assistant", content: content2 } });
    }

    if (
      toolCall.name === "github_search" ||
      toolCall.name === "github_read" ||
      toolCall.name === "github_list" ||
      toolCall.name === "github_repos"
    ) {
      const token = getGitHubTokenFromRequest(req);
      if (!token) {
        return json(
          { ok: false, error: "Not connected to GitHub. Connect in /settings." },
          { status: 401 },
        );
      }

      const maxCharsEnv = Number(process.env.GITHUB_MAX_CHARS ?? "60000");
      const maxChars = clampNumber(
        Number.isNaN(maxCharsEnv) ? 60000 : maxCharsEnv,
        2000,
        200000,
      );
      const maxItemsEnv = Number(process.env.GITHUB_MAX_LIST_ITEMS ?? "200");
      const maxItems = clampNumber(
        Number.isNaN(maxItemsEnv) ? 200 : maxItemsEnv,
        20,
        2000,
      );
      const maxReposEnv = Number(process.env.GITHUB_MAX_REPOS ?? "80");
      const maxRepos = clampNumber(Number.isNaN(maxReposEnv) ? 80 : maxReposEnv, 10, 500);

      let toolResultText = "";
      try {
        if (toolCall.name === "github_repos") {
          const repos = await githubRepos({
            token,
            query: toolCall.arguments.query,
            maxItems: maxRepos,
          });
          toolResultText =
            `Tool result (github_repos)\nquery: ${toolCall.arguments.query ?? ""}\n\n` +
            repos.map((r) => `- ${r.fullName} (default: ${r.defaultBranch}${r.private ? ", private" : ""})`).join("\n");
        } else if (toolCall.name === "github_search") {
          if (!githubRepo) {
            return json(
              { ok: false, error: "GitHub tool requested but no repo selected. Configure it in /settings." },
              { status: 400 },
            );
          }
          const results = await githubSearch({
            token,
            owner: githubRepo.owner,
            repo: githubRepo.repo,
            query: toolCall.arguments.query,
          });
          toolResultText = `Tool result (github_search)\nrepo: ${githubRepo.owner}/${githubRepo.repo}\nquery: ${toolCall.arguments.query}\n\n` +
            results.map((r) => `- ${r.path}${r.htmlUrl ? ` (${r.htmlUrl})` : ""}`).join("\n");
        } else if (toolCall.name === "github_list") {
          if (!githubRepo) {
            return json(
              { ok: false, error: "GitHub tool requested but no repo selected. Configure it in /settings." },
              { status: 400 },
            );
          }
          const listing = await githubList({
            token,
            owner: githubRepo.owner,
            repo: githubRepo.repo,
            path: toolCall.arguments.path,
            ref: githubRepo.ref || undefined,
            maxItems,
          });
          const shown = listing.items;
          const labelPath = toolCall.arguments.path?.trim() ? toolCall.arguments.path.trim() : "/";
          toolResultText =
            `Tool result (github_list)\nrepo: ${githubRepo.owner}/${githubRepo.repo}\npath: ${labelPath}\n\n` +
            shown
              .map((i) => {
                const kind = i.type === "dir" ? "dir" : i.type === "file" ? "file" : i.type;
                const size = i.size != null && kind === "file" ? ` (${i.size} bytes)` : "";
                return `- [${kind}] ${i.path}${i.type === "dir" ? "/" : ""}${size}`;
              })
              .join("\n") +
            (listing.total > shown.length ? `\n\n(truncated: showing ${shown.length} of ${listing.total})` : "");
        } else {
          if (!githubRepo) {
            return json(
              { ok: false, error: "GitHub tool requested but no repo selected. Configure it in /settings." },
              { status: 400 },
            );
          }
          const fileText = await githubRead({
            token,
            owner: githubRepo.owner,
            repo: githubRepo.repo,
            path: toolCall.arguments.path,
            ref: githubRepo.ref || undefined,
            maxChars,
          });
          toolResultText =
            `Tool result (github_read)\nrepo: ${githubRepo.owner}/${githubRepo.repo}\npath: ${toolCall.arguments.path}\n\n` +
            fileText;
        }
      } catch (e) {
        return json(
          { ok: false, error: e instanceof Error ? e.message : "GitHub tool failed." },
          { status: 502 },
        );
      }

      const toolResultSystem = { role: "system" as const, content: toolResultText };
      const followUpMessages = [
        ...preparedMessages,
        { role: "assistant" as const, content },
        toolResultSystem,
      ];

      const upstream2 = await callXai({
        apiKey,
        baseUrl,
        model,
        temperature,
        messages: followUpMessages,
      });

      if (!upstream2.ok) {
        const text = await upstream2.text().catch(() => "");
        return json(
          { ok: false, error: `xAI error (${upstream2.status}). ${text || "No response body."}` },
          { status: 502 },
        );
      }

      const data2 = (await upstream2.json()) as unknown;
      const content2 = extractFirstContent(data2);
      if (typeof content2 !== "string" || !content2.trim()) {
        return json(
          { ok: false, error: "Unexpected xAI response format (missing content)." },
          { status: 502 },
        );
      }

      return json({ ok: true, message: { role: "assistant", content: content2 } });
    }
  }

  return json({ ok: true, message: { role: "assistant", content } });
}
