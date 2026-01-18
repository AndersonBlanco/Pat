"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Settings = {
  model: string;
  temperature: number;
  systemPrompt: string;
  webScrapeEnabled: boolean;
  webScrapeAuto: boolean;
  githubEnabled: boolean;
  githubRepo: { owner: string; repo: string; ref: string } | null;
};

const SETTINGS_KEY = "pat.settings.v1";

const DEFAULT_SETTINGS: Settings = {
  model: "grok-3",
  temperature: 0.3,
  systemPrompt:
    "You are Grok, running in a sleek JARVIS-style console. Be direct, helpful, and technical. Use short, actionable answers. Ask clarifying questions when needed.",
  webScrapeEnabled: false,
  webScrapeAuto: true,
  githubEnabled: false,
  githubRepo: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clampNumber(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return DEFAULT_SETTINGS;

    const githubRepoRaw = parsed.githubRepo;
    const githubRepo =
      isRecord(githubRepoRaw) &&
      typeof githubRepoRaw.owner === "string" &&
      typeof githubRepoRaw.repo === "string"
        ? {
            owner: githubRepoRaw.owner,
            repo: githubRepoRaw.repo,
            ref: typeof githubRepoRaw.ref === "string" ? githubRepoRaw.ref : "",
          }
        : null;

    return {
      model: typeof parsed.model === "string" ? parsed.model : DEFAULT_SETTINGS.model,
      temperature:
        typeof parsed.temperature === "number"
          ? clampNumber(parsed.temperature, 0, 2)
          : DEFAULT_SETTINGS.temperature,
      systemPrompt:
        typeof parsed.systemPrompt === "string"
          ? parsed.systemPrompt
          : DEFAULT_SETTINGS.systemPrompt,
      webScrapeEnabled:
        typeof parsed.webScrapeEnabled === "boolean"
          ? parsed.webScrapeEnabled
          : DEFAULT_SETTINGS.webScrapeEnabled,
      webScrapeAuto:
        typeof parsed.webScrapeAuto === "boolean"
          ? parsed.webScrapeAuto
          : DEFAULT_SETTINGS.webScrapeAuto,
      githubEnabled:
        typeof parsed.githubEnabled === "boolean"
          ? parsed.githubEnabled
          : DEFAULT_SETTINGS.githubEnabled,
      githubRepo,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export default function SettingsClient() {
  const initial = readSettings();
  const [model, setModel] = useState(initial.model);
  const [temperature, setTemperature] = useState(initial.temperature);
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt);
  const [webScrapeEnabled, setWebScrapeEnabled] = useState(initial.webScrapeEnabled);
  const [webScrapeAuto, setWebScrapeAuto] = useState(initial.webScrapeAuto);
  const [githubEnabled, setGithubEnabled] = useState(initial.githubEnabled);
  const [githubRepo, setGithubRepo] = useState<Settings["githubRepo"]>(initial.githubRepo);

  const [githubStatus, setGithubStatus] = useState<
    { connected: false } | { connected: true; login: string }
  >({ connected: false });
  const [githubRepos, setGithubRepos] = useState<
    Array<{ id: number; owner: string; name: string; fullName: string; private: boolean; defaultBranch: string }>
  >([]);
  const [githubError, setGithubError] = useState<string | null>(null);

  const modelOptions = [
    "grok-4-1-fast-reasoning",
    "grok-4-1-fast-non-reasoning",
    "grok-4-fast-reasoning",
    "grok-4-fast-non-reasoning",
    "grok-4-0709",
    "grok-code-fast-1",
    "grok-3",
    "grok-3-mini",
    "grok-2-vision-1212",
  ];

  useEffect(() => {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify(
          { model, temperature, systemPrompt, webScrapeEnabled, webScrapeAuto, githubEnabled, githubRepo } satisfies Settings,
        ),
      );
    } catch {
      // ignore
    }
  }, [githubEnabled, githubRepo, model, systemPrompt, temperature, webScrapeAuto, webScrapeEnabled]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/github/status")
      .then((r) => r.json())
      .then((data: unknown) => {
        if (cancelled) return;
        if (!isRecord(data) || data.ok !== true) return;
        if (data.connected === true && typeof data.login === "string") {
          setGithubStatus({ connected: true, login: data.login });
        } else {
          setGithubStatus({ connected: false });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!githubStatus.connected) return;
    let cancelled = false;
    fetch("/api/github/repos")
      .then((r) => r.json())
      .then((data: unknown) => {
        if (cancelled) return;
        if (!isRecord(data) || data.ok !== true || !Array.isArray(data.repos)) return;
        setGithubError(null);
        const list: Array<{
          id: number;
          owner: string;
          name: string;
          fullName: string;
          private: boolean;
          defaultBranch: string;
        }> = [];
        for (const item of data.repos) {
          if (!isRecord(item)) continue;
          if (typeof item.id !== "number") continue;
          if (typeof item.owner !== "string") continue;
          if (typeof item.name !== "string") continue;
          if (typeof item.fullName !== "string") continue;
          if (typeof item.private !== "boolean") continue;
          if (typeof item.defaultBranch !== "string") continue;
          list.push({
            id: item.id,
            owner: item.owner,
            name: item.name,
            fullName: item.fullName,
            private: item.private,
            defaultBranch: item.defaultBranch,
          });
        }
        setGithubRepos(list);
      })
      .catch((e) => {
        if (cancelled) return;
        setGithubError(e instanceof Error ? e.message : "GitHub request failed.");
      });
    return () => {
      cancelled = true;
    };
  }, [githubStatus.connected]);

  return (
    <div className="jarvis-bg h-dvh overflow-hidden">
      <div className="mx-auto flex h-full w-full max-w-4xl px-4 py-5 md:px-6">
        <main className="jarvis-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden">
          <header className="jarvis-header px-4 py-3 md:px-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="jarvis-logo" aria-hidden="true">
                  P
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[color:var(--jarvis-text)]">
                    Configuration
                  </div>
                  <div className="truncate text-[12px] text-[color:var(--jarvis-muted)]">
                    Model, temperature, and system prompt
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="jarvis-button"
                  onClick={() => {
                    setModel(DEFAULT_SETTINGS.model);
                    setTemperature(DEFAULT_SETTINGS.temperature);
                    setSystemPrompt(DEFAULT_SETTINGS.systemPrompt);
                    setWebScrapeEnabled(DEFAULT_SETTINGS.webScrapeEnabled);
                    setWebScrapeAuto(DEFAULT_SETTINGS.webScrapeAuto);
                    setGithubEnabled(DEFAULT_SETTINGS.githubEnabled);
                    setGithubRepo(DEFAULT_SETTINGS.githubRepo);
                  }}
                >
                  Reset
                </button>
                <Link href="/" className="jarvis-button">
                  Back
                </Link>
              </div>
            </div>
          </header>

          <div className="jarvis-divider" />

          <section className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 md:px-5">
            <div className="mx-auto w-full max-w-2xl space-y-5">
              <div>
                <div className="mb-2 text-[12px] font-medium text-[color:var(--jarvis-muted)]">
                  Model
                </div>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="jarvis-input h-11 w-full px-3 text-[14px]"
                >
                  {modelOptions.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between text-[12px] font-medium text-[color:var(--jarvis-muted)]">
                  <span>Temperature</span>
                  <span className="tabular-nums text-[color:var(--jarvis-text)]">
                    {temperature.toFixed(1)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                  className="jarvis-range w-full"
                />
              </div>

              <div>
                <div className="mb-2 text-[12px] font-medium text-[color:var(--jarvis-muted)]">
                  System prompt
                </div>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={10}
                  className="jarvis-input w-full resize-none px-3 py-3 text-[14px] leading-6"
                  placeholder="Define Grok behavior…"
                />
              </div>

              <div className="jarvis-divider" />

              <div>
                <div className="mb-2 text-[12px] font-medium text-[color:var(--jarvis-muted)]">
                  Web scrape mode (Firecrawl)
                </div>

                <label className="jarvis-check">
                  <input
                    type="checkbox"
                    checked={webScrapeEnabled}
                    onChange={(e) => setWebScrapeEnabled(e.target.checked)}
                  />
                  <span className="jarvis-check-text">Enable web scraping</span>
                </label>

                <label className="jarvis-check mt-2">
                  <input
                    type="checkbox"
                    checked={webScrapeAuto}
                    onChange={(e) => setWebScrapeAuto(e.target.checked)}
                    disabled={!webScrapeEnabled}
                  />
                  <span className="jarvis-check-text">
                    Auto-attach content when your message includes a URL
                  </span>
                </label>

                <div className="mt-3 text-[12px] text-[color:var(--jarvis-muted)]">
                  When enabled, Pat can attach scraped content automatically and also lets Grok request a scrape as a tool.
                  Tip: <span className="jarvis-kbd">/scrape</span>{" "}
                  <span className="jarvis-kbd">https://example.com</span>{" "}
                  <span className="jarvis-kbd">your question</span>
                </div>
              </div>

              <div className="jarvis-divider" />

              <div>
                <div className="mb-2 text-[12px] font-medium text-[color:var(--jarvis-muted)]">
                  GitHub Connect (Repo tools)
                </div>

                {githubStatus.connected ? (
                  <div className="space-y-3">
                    <div className="text-[13px] text-[color:var(--jarvis-text)]">
                      Connected as <span className="font-semibold">{githubStatus.login}</span>
                    </div>

                    <div className="flex gap-2">
                      <form action="/api/auth/github/disconnect" method="post" className="flex-1">
                        <button type="submit" className="jarvis-button w-full">
                          Disconnect
                        </button>
                      </form>
                      <Link href="/api/auth/github/start" className="jarvis-button flex-1 text-center">
                        Reconnect
                      </Link>
                    </div>

                    <label className="jarvis-check">
                      <input
                        type="checkbox"
                        checked={githubEnabled}
                        onChange={(e) => setGithubEnabled(e.target.checked)}
                      />
                      <span className="jarvis-check-text">Enable GitHub repo tools</span>
                    </label>

                    <div className="space-y-2">
                      <div className="text-[12px] text-[color:var(--jarvis-muted)]">Repository</div>
                      <select
                        value={githubRepo ? `${githubRepo.owner}/${githubRepo.repo}` : ""}
                        onChange={(e) => {
                          const selected = e.target.value;
                          const match = githubRepos.find((r) => r.fullName === selected);
                          if (!match) {
                            setGithubRepo(null);
                            return;
                          }
                          setGithubRepo({
                            owner: match.owner,
                            repo: match.name,
                            ref: match.defaultBranch,
                          });
                          setGithubEnabled(true);
                        }}
                        className="jarvis-input h-11 w-full px-3 text-[14px]"
                      >
                        <option value="">Select a repo…</option>
                        {githubRepos.map((r) => (
                          <option key={r.id} value={r.fullName}>
                            {r.fullName}
                            {r.private ? " (private)" : ""}
                          </option>
                        ))}
                      </select>
                    </div>

                    {githubRepo ? (
                      <div className="space-y-2">
                        <div className="text-[12px] text-[color:var(--jarvis-muted)]">Branch / ref</div>
                        <input
                          value={githubRepo.ref}
                          onChange={(e) =>
                            setGithubRepo({ ...githubRepo, ref: e.target.value })
                          }
                          placeholder="main"
                          className="jarvis-input h-11 w-full px-3 text-[14px]"
                        />
                        <div className="text-[12px] text-[color:var(--jarvis-muted)]">
                          Grok can use tools like <span className="jarvis-kbd">github_search</span> and{" "}
                          <span className="jarvis-kbd">github_read</span> on the selected repo.
                        </div>
                      </div>
                    ) : null}

                    {githubError ? <div className="jarvis-error text-sm">{githubError}</div> : null}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="text-[13px] text-[color:var(--jarvis-muted)]">
                      Connect GitHub to let Grok read/search a selected repo.
                    </div>
                    <Link href="/api/auth/github/start" className="jarvis-link-button">
                      Connect GitHub
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
