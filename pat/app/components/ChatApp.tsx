"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import GalaxyBackground from "./GalaxyBackground";

type Role = "system" | "user" | "assistant";

type ChatMessage = {
  id: string;
  role: Exclude<Role, "system">;
  content: string;
};

type Settings = {
  model: string;
  temperature: number;
  systemPrompt: string;
  webScrapeEnabled: boolean;
  webScrapeAuto: boolean;
  theme: "default" | "galaxy";
  todoistToken: string;
  githubEnabled: boolean;
  githubRepo: { owner: string; repo: string; ref: string } | null;
};

type Project = {
  id: string;
  name: string;
};

type Task = {
  id: string;
  title: string;
  completed: boolean;
};

type TodoistSidebarTask = {
  id: string;
  title: string;
  completed: boolean;
  url: string;
  due: { date?: string; datetime?: string; string?: string; timezone?: string | null } | null;
};

type WebPin = {
  id: string;
  title: string;
  url: string;
  createdAt: number;
};

type DagSnapshot = {
  nodes: Array<{
    id: string;
    title: string;
    description?: string;
    score?: number;
    tags?: string[];
    x: number;
    y: number;
  }>;
  edges: Array<{ id: string; source: string; target: string }>;
  version?: number;
};

type ApiResponse =
  | { ok: true; message: { role: "assistant"; content: string } }
  | { ok: false; error: string };

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type VoiceWsSession = {
  ws: WebSocket;
  micStream: MediaStream;
  audioContext: AudioContext;
  processor: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode;
  silentGain: GainNode;
  nextPlayTime: number;
};

const SETTINGS_KEY = "pat.settings.v1";
const MESSAGES_KEY = "pat.messages.v1";
const PROJECTS_KEY = "pat.projects.v1";
const TASKS_KEY = "pat.tasks.v1";
const WEB_PINS_KEY = "pat.webPins.v1";
const ACTIVE_PROJECT_KEY = "pat.activeProjectId.v1";
const SIDEBAR_KEY = "pat.sidebar.v1";
const DAG_KEY = "pat.dag.v1";
const DAG_ASK_PAT_KEY = "pat.dag.askPat.v1";
const TODOIST_TASK_LABEL = "Task";

const DEFAULT_SETTINGS: Settings = {
  model: "grok-3",
  temperature: 0.3,
  systemPrompt:
    "You are Grok, running in a sleek JARVIS-style console. Be direct, helpful, and technical. Use short, actionable answers. Ask clarifying questions when needed.",
  webScrapeEnabled: false,
  webScrapeAuto: true,
  theme: "default",
  todoistToken: "",
  githubEnabled: false,
  githubRepo: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function clampNumber(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number) {
  return Math.round(clampNumber(value, min, max));
}

function safeLocalStorageGet(key: string) {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function readJson(key: string): unknown {
  const raw = safeLocalStorageGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function titleFromUrl(url: string) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const lastPath = u.pathname.split("/").filter(Boolean).slice(-1)[0] ?? "";
    const cleanedPath = decodeURIComponent(lastPath).replace(/[-_]+/g, " ").trim();
    const parts = cleanedPath ? cleanedPath.split(/\s+/) : [];
    const words = parts.slice(0, 3);
    if (words.length) return `${host} ${words.join(" ")}`.trim();
    return host;
  } catch {
    return url;
  }
}

function toFiveWords(text: string) {
  const cleaned = text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[`*_#[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter(Boolean).slice(0, 5);
  return words.join(" ");
}

function extractMarkdownLinkTitle(message: string, url: string) {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[([^\\]]{1,120})\\]\\(${escaped}\\)`, "i");
  const match = message.match(re);
  return match?.[1]?.trim() || null;
}

function findLatestUrl(
  messages: ChatMessage[],
  opts?: { role?: ChatMessage["role"] },
): { url: string; context: string } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg) continue;
    if (opts?.role && msg.role !== opts.role) continue;
    const text = msg.content ?? "";
    const match = text.match(/https?:\/\/[^\s<>()\]]+/i);
    if (!match) continue;
    const url = match[0].replace(/[).,]+$/, "");
    return { url, context: text };
  }
  return null;
}

function normalizePinUrl(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^\/(?!\/)/.test(trimmed)) return null;
  if (/^\/\//.test(trimmed)) return `https:${trimmed}`;

  const withoutScheme = trimmed.replace(/^[a-z]+:\/\//i, "");
  const hostish = withoutScheme.split("/")[0] ?? "";

  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/i.test(hostish)) {
    return `http://${withoutScheme}`;
  }

  if (/^www\./i.test(withoutScheme) || withoutScheme.includes(".")) {
    return `https://${withoutScheme}`;
  }

  return null;
}

export default function ChatApp() {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceTranscriptRef = useRef("");
  const voiceStopShouldSendRef = useRef(false);
  const sendRef = useRef<(override?: unknown) => Promise<void> | void>(() => {});
  const voiceWsRef = useRef<VoiceWsSession | null>(null);
  const voiceWsClosingRef = useRef(false);
  const voiceSessionPhaseRef = useRef<"idle" | "connecting" | "recording" | "responding" | "error">("idle");

  const [model, setModel] = useState(DEFAULT_SETTINGS.model);
  const [temperature, setTemperature] = useState(DEFAULT_SETTINGS.temperature);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SETTINGS.systemPrompt);
  const [webScrapeEnabled, setWebScrapeEnabled] = useState(DEFAULT_SETTINGS.webScrapeEnabled);
  const [webScrapeAuto, setWebScrapeAuto] = useState(DEFAULT_SETTINGS.webScrapeAuto);
  const [theme, setTheme] = useState<Settings["theme"]>(DEFAULT_SETTINGS.theme);
  const [todoistToken, setTodoistToken] = useState(DEFAULT_SETTINGS.todoistToken);
  const [githubEnabled, setGithubEnabled] = useState(DEFAULT_SETTINGS.githubEnabled);
  const [githubRepo, setGithubRepo] = useState<Settings["githubRepo"]>(DEFAULT_SETTINGS.githubRepo);

  const todoistEnabled = Boolean(todoistToken.trim());

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: uid(),
      role: "assistant",
      content:
        "JARVIS online. Give me your objective, and I’ll route it through Grok.",
    },
  ]);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [isListening, setIsListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [isVoiceSessionActive, setIsVoiceSessionActive] = useState(false);
  const [voiceSessionStatus, setVoiceSessionStatus] = useState<
    "idle" | "connecting" | "recording" | "responding" | "error"
  >("idle");
  const [voiceSessionError, setVoiceSessionError] = useState<string | null>(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [modelOpen, setModelOpen] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [tasksOpen, setTasksOpen] = useState(true);
  const [pinsOpen, setPinsOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [hydrated, setHydrated] = useState(false);
  const [dag, setDag] = useState<DagSnapshot | null>(null);

  const [projects, setProjects] = useState<Project[]>([
    { id: "inbox", name: "Inbox" },
  ]);
  const [activeProjectId, setActiveProjectId] = useState("inbox");
  const [tasksByProject, setTasksByProject] = useState<Record<string, Task[]>>({
    inbox: [],
  });
  const [pinsByProject, setPinsByProject] = useState<Record<string, WebPin[]>>({
    inbox: [],
  });

  const [todoistTasks, setTodoistTasks] = useState<TodoistSidebarTask[]>([]);
  const [todoistTasksLoading, setTodoistTasksLoading] = useState(false);
  const [todoistTasksError, setTodoistTasksError] = useState<string | null>(null);

  const [newProjectName, setNewProjectName] = useState("");
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newPinUrl, setNewPinUrl] = useState("");

  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dragPinId, setDragPinId] = useState<string | null>(null);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

  const apiMessages = useMemo(() => {
    const wire: Array<{ role: Role; content: string }> = [];
    if (systemPrompt.trim()) wire.push({ role: "system", content: systemPrompt });
    for (const m of messages) wire.push({ role: m.role, content: m.content });
    return wire;
  }, [messages, systemPrompt]);

  const workspaceContextForModel = useMemo(() => {
    const activeProject =
      projects.find((p) => p.id === activeProjectId) ?? { id: activeProjectId, name: "Inbox" };

    const projectsPayload = projects.slice(0, 30).map((p) => ({ id: p.id, name: p.name }));
    const displayedTasks = todoistEnabled ? todoistTasks : tasksByProject[activeProjectId] ?? [];
    const tasks = displayedTasks.slice(0, 60).map((t) => ({
      id: t.id,
      title: t.title,
      completed: t.completed,
      source: todoistEnabled ? "todoist" : "local",
    }));
    const webPins = (pinsByProject[activeProjectId] ?? [])
      .slice(0, 60)
      .map((p) => ({ id: p.id, title: p.title, url: p.url }));

    const canvasDag = dag
      ? {
          nodes: dag.nodes.slice(0, 40).map((n) => ({
            id: n.id,
            title: n.title,
            tags: n.tags ?? [],
            score: n.score ?? null,
          })),
          edges: dag.edges.slice(0, 60).map((e) => ({ source: e.source, target: e.target })),
          meta: {
            nodeCount: dag.nodes.length,
            edgeCount: dag.edges.length,
            truncated: { nodes: dag.nodes.length > 40, edges: dag.edges.length > 60 },
          },
        }
      : null;

    const payload = {
      activeProject: { id: activeProject.id, name: activeProject.name },
      projects: projectsPayload,
      tasks,
      webPins,
      canvasDag,
      github: {
        toolsEnabled: githubEnabled,
        selectedRepo: githubRepo ? `${githubRepo.owner}/${githubRepo.repo}` : null,
        ref: githubRepo?.ref || "",
      },
      todoist: {
        connected: todoistEnabled,
        labelFilter: todoistEnabled ? TODOIST_TASK_LABEL : "",
      },
      meta: {
        truncated: {
          projects: projects.length > projectsPayload.length,
          tasks: displayedTasks.length > tasks.length,
          webPins: (pinsByProject[activeProjectId] ?? []).length > webPins.length,
        },
      },
    };

    return `Workspace context (Projects/Tasks/Web Pins): ${JSON.stringify(payload)}`;
  }, [activeProjectId, dag, githubEnabled, githubRepo, pinsByProject, projects, tasksByProject, todoistEnabled, todoistTasks]);

  const refreshTodoistTasks = useCallback(async (signal?: AbortSignal) => {
    if (!todoistEnabled) {
      setTodoistTasks([]);
      setTodoistTasksError(null);
      setTodoistTasksLoading(false);
      return;
    }

    setTodoistTasksLoading(true);
    try {
      const res = await fetch(`/api/todoist/tasks?label=${encodeURIComponent(TODOIST_TASK_LABEL)}&limit=120`, {
        headers: { authorization: `Bearer ${todoistToken}` },
        signal,
      });

      const data = (await res.json().catch(() => null)) as
        | { ok: true; tasks: TodoistSidebarTask[]; total: number }
        | { ok: false; error: string }
        | null;

      if (!res.ok || !data || data.ok === false) {
        const message = (data && "error" in data && data.error) || `Todoist request failed (${res.status})`;
        throw new Error(message);
      }

      setTodoistTasksError(null);
      setTodoistTasks(data.tasks);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setTodoistTasksError(e instanceof Error ? e.message : "Todoist request failed.");
    } finally {
      setTodoistTasksLoading(false);
    }
  }, [todoistEnabled, todoistToken]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshTodoistTasks(controller.signal);
    return () => {
      controller.abort();
    };
  }, [refreshTodoistTasks]);

  useEffect(() => {
    if (!todoistEnabled) return;
    const id = window.setInterval(() => {
      void refreshTodoistTasks();
    }, 60_000);
    return () => window.clearInterval(id);
  }, [todoistEnabled, refreshTodoistTasks]);

  useEffect(() => {
    function syncSettingsFromStorage() {
      try {
        const rawSettings = safeLocalStorageGet(SETTINGS_KEY);
        if (!rawSettings) return;
        const parsed = JSON.parse(rawSettings) as unknown;
        if (!isRecord(parsed)) return;

        if (typeof parsed.model === "string") setModel(parsed.model);
        if (typeof parsed.temperature === "number") {
          setTemperature(clampNumber(parsed.temperature, 0, 2));
        }
        if (typeof parsed.systemPrompt === "string") setSystemPrompt(parsed.systemPrompt);
        if (typeof parsed.webScrapeEnabled === "boolean") setWebScrapeEnabled(parsed.webScrapeEnabled);
        if (typeof parsed.webScrapeAuto === "boolean") setWebScrapeAuto(parsed.webScrapeAuto);
        if (parsed.theme === "default" || parsed.theme === "galaxy") setTheme(parsed.theme);
        if (typeof parsed.todoistToken === "string") setTodoistToken(parsed.todoistToken);
        if (typeof parsed.githubEnabled === "boolean") setGithubEnabled(parsed.githubEnabled);

        const githubRepoRaw = parsed.githubRepo;
        if (
          isRecord(githubRepoRaw) &&
          typeof githubRepoRaw.owner === "string" &&
          typeof githubRepoRaw.repo === "string"
        ) {
          setGithubRepo({
            owner: githubRepoRaw.owner,
            repo: githubRepoRaw.repo,
            ref: typeof githubRepoRaw.ref === "string" ? githubRepoRaw.ref : "",
          });
        } else {
          setGithubRepo(null);
        }
      } catch {
        // ignore
      }
    }

    function syncDagFromStorage() {
      try {
        const raw = safeLocalStorageGet(DAG_KEY);
        if (!raw) {
          setDag(null);
          return;
        }
        const parsed = JSON.parse(raw) as unknown;
        if (!isRecord(parsed)) {
          setDag(null);
          return;
        }
        const nodesRaw = parsed.nodes;
        const edgesRaw = parsed.edges;
        if (!Array.isArray(nodesRaw) || !Array.isArray(edgesRaw)) {
          setDag(null);
          return;
        }
        const nodes: DagSnapshot["nodes"] = [];
        for (const n of nodesRaw) {
          if (!isRecord(n)) continue;
          if (typeof n.id !== "string" || typeof n.title !== "string") continue;
          if (typeof n.x !== "number" || typeof n.y !== "number") continue;
          nodes.push({
            id: n.id,
            title: n.title,
            x: n.x,
            y: n.y,
            description: typeof n.description === "string" ? n.description : undefined,
            score: typeof n.score === "number" ? n.score : undefined,
            tags: Array.isArray(n.tags) ? n.tags.filter((t) => typeof t === "string") : undefined,
          });
        }
        const edges: DagSnapshot["edges"] = [];
        for (const e of edgesRaw) {
          if (!isRecord(e)) continue;
          if (typeof e.id !== "string" || typeof e.source !== "string" || typeof e.target !== "string") continue;
          edges.push({ id: e.id, source: e.source, target: e.target });
        }
        setDag({ nodes, edges, version: typeof parsed.version === "number" ? parsed.version : undefined });
      } catch {
        setDag(null);
      }
    }

    function hydrateFromStorage() {
      syncSettingsFromStorage();
      syncDagFromStorage();

      try {
        const rawMessages = safeLocalStorageGet(MESSAGES_KEY);
        if (rawMessages) {
          const parsed = JSON.parse(rawMessages) as unknown;
          if (Array.isArray(parsed)) {
            const loaded: ChatMessage[] = [];
            for (const item of parsed) {
              if (!isRecord(item)) continue;
              const role = item.role;
              const content = item.content;
              if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
              loaded.push({ id: uid(), role, content });
            }
            if (loaded.length) setMessages(loaded);
          }
        }
      } catch {
        // ignore
      }

      const parsedProjects = readJson(PROJECTS_KEY);
      if (Array.isArray(parsedProjects)) {
        const loaded: Project[] = [];
        for (const item of parsedProjects) {
          if (!isRecord(item)) continue;
          if (typeof item.id !== "string" || typeof item.name !== "string") continue;
          loaded.push({ id: item.id, name: item.name });
        }
        const hasInbox = loaded.some((p) => p.id === "inbox");
        setProjects(hasInbox ? loaded : [{ id: "inbox", name: "Inbox" }, ...loaded]);
      }

      const parsedTasks = readJson(TASKS_KEY);
      if (isRecord(parsedTasks)) {
        const loaded: Record<string, Task[]> = {};
        for (const [projectId, value] of Object.entries(parsedTasks)) {
          if (!Array.isArray(value)) continue;
          const tasks: Task[] = [];
          for (const item of value) {
            if (!isRecord(item)) continue;
            if (typeof item.id !== "string" || typeof item.title !== "string") continue;
            tasks.push({
              id: item.id,
              title: item.title,
              completed: typeof item.completed === "boolean" ? item.completed : false,
            });
          }
          loaded[projectId] = tasks;
        }
        if (!loaded.inbox) loaded.inbox = [];
        setTasksByProject(loaded);
      }

      const parsedPins = readJson(WEB_PINS_KEY);
      if (isRecord(parsedPins)) {
        const loaded: Record<string, WebPin[]> = {};
        for (const [projectId, value] of Object.entries(parsedPins)) {
          if (!Array.isArray(value)) continue;
          const pins: WebPin[] = [];
          for (const item of value) {
            if (!isRecord(item)) continue;
            if (typeof item.id !== "string") continue;
            if (typeof item.title !== "string") continue;
            if (typeof item.url !== "string") continue;
            const normalized = normalizePinUrl(item.url);
            if (!normalized) continue;
            pins.push({
              id: item.id,
              title: item.title,
              url: normalized,
              createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
            });
          }
          loaded[projectId] = pins;
        }
        if (!loaded.inbox) loaded.inbox = [];
        setPinsByProject(loaded);
      }

      const parsedActive = safeLocalStorageGet(ACTIVE_PROJECT_KEY);
      if (parsedActive) setActiveProjectId(parsedActive);

      const parsedSidebar = readJson(SIDEBAR_KEY);
      if (isRecord(parsedSidebar)) {
        if (typeof parsedSidebar.collapsed === "boolean") setSidebarCollapsed(parsedSidebar.collapsed);
        if (typeof parsedSidebar.modelOpen === "boolean") setModelOpen(parsedSidebar.modelOpen);
        if (typeof parsedSidebar.projectsOpen === "boolean") setProjectsOpen(parsedSidebar.projectsOpen);
        if (typeof parsedSidebar.tasksOpen === "boolean") setTasksOpen(parsedSidebar.tasksOpen);
        if (typeof parsedSidebar.pinsOpen === "boolean") setPinsOpen(parsedSidebar.pinsOpen);
        if (typeof parsedSidebar.width === "number") setSidebarWidth(clampInt(parsedSidebar.width, 260, 520));
      }
    }

    hydrateFromStorage();
    setHydrated(true);

    function onFocus() {
      syncSettingsFromStorage();
      syncDagFromStorage();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        syncSettingsFromStorage();
        syncDagFromStorage();
      }
    }

    function onStorage(e: StorageEvent) {
      if (e.key === SETTINGS_KEY) syncSettingsFromStorage();
      if (e.key === DAG_KEY) syncDagFromStorage();
    }

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    try {
      if (!hydrated) return;
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify(
          {
            model,
            temperature,
            systemPrompt,
            webScrapeEnabled,
            webScrapeAuto,
            theme,
            todoistToken,
            githubEnabled,
            githubRepo,
          } satisfies Settings,
        ),
      );
    } catch {
      // ignore
    }
  }, [githubEnabled, githubRepo, hydrated, model, systemPrompt, temperature, theme, todoistToken, webScrapeAuto, webScrapeEnabled]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      const raw = localStorage.getItem(DAG_ASK_PAT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || typeof parsed.question !== "string") return;
      localStorage.removeItem(DAG_ASK_PAT_KEY);
      const q = parsed.question.trim();
      if (!q) return;
      setDraft((prev) => (prev.trim() ? `${prev.trim()}\n\n${q}` : q));
    } catch {
      // ignore
    }
  }, [hydrated]);

  useEffect(() => {
    try {
      if (!hydrated) return;
      localStorage.setItem(
        MESSAGES_KEY,
        JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content }))),
      );
    } catch {
      // ignore
    }
  }, [hydrated, messages]);

  useEffect(() => {
    if (!hydrated) return;
    safeLocalStorageSet(PROJECTS_KEY, JSON.stringify(projects));
  }, [hydrated, projects]);

  useEffect(() => {
    if (!hydrated) return;
    safeLocalStorageSet(TASKS_KEY, JSON.stringify(tasksByProject));
  }, [hydrated, tasksByProject]);

  useEffect(() => {
    if (!hydrated) return;
    safeLocalStorageSet(WEB_PINS_KEY, JSON.stringify(pinsByProject));
  }, [hydrated, pinsByProject]);

  useEffect(() => {
    if (!hydrated) return;
    safeLocalStorageSet(ACTIVE_PROJECT_KEY, activeProjectId);
  }, [activeProjectId, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    safeLocalStorageSet(
      SIDEBAR_KEY,
      JSON.stringify({
        collapsed: sidebarCollapsed,
        modelOpen,
        projectsOpen,
        tasksOpen,
        pinsOpen,
        width: sidebarWidth,
      }),
    );
  }, [hydrated, modelOpen, pinsOpen, projectsOpen, sidebarCollapsed, sidebarWidth, tasksOpen]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isSending]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const SpeechRecognitionCtor =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      setVoiceSupported(false);
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: unknown) => {
      const e = event as {
        resultIndex?: number;
        results?: ArrayLike<ArrayLike<{ transcript?: string } & { confidence?: number }> & { isFinal?: boolean }>;
      };
      const results = e.results;
      if (!results) return;

      let finalText = voiceTranscriptRef.current;
      let interimText = "";
      const start = typeof e.resultIndex === "number" ? e.resultIndex : 0;

      for (let i = start; i < results.length; i += 1) {
        const result = results[i];
        const transcript = (result?.[0]?.transcript ?? "").trim();
        if (!transcript) continue;
        if (result?.isFinal) {
          finalText = `${finalText} ${transcript}`.trim();
        } else {
          interimText = `${interimText} ${transcript}`.trim();
        }
      }

      voiceTranscriptRef.current = finalText;
      const combined = `${finalText} ${interimText}`.trim();
      if (combined) setDraft(combined);
    };

    recognition.onerror = (event: unknown) => {
      const e = event as { error?: string };
      setVoiceError(e.error ? `Voice error: ${e.error}` : "Voice error.");
      setIsListening(false);
      setVoiceEnabled(false);
      voiceStopShouldSendRef.current = false;
    };

    recognition.onend = () => {
      setIsListening(false);
      if (!voiceStopShouldSendRef.current) return;
      voiceStopShouldSendRef.current = false;
      const text = voiceTranscriptRef.current.trim();
      voiceTranscriptRef.current = "";
      if (text) sendRef.current(text);
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognitionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!voiceEnabled) window.speechSynthesis?.cancel();
  }, [voiceEnabled]);

  useEffect(() => {
    return () => {
      try {
        voiceWsClosingRef.current = true;
        voiceWsRef.current?.ws.close();
      } catch {
        // ignore
      }
      try {
        voiceWsRef.current?.processor.disconnect();
        voiceWsRef.current?.source.disconnect();
        voiceWsRef.current?.silentGain.disconnect();
      } catch {
        // ignore
      }
      try {
        void voiceWsRef.current?.audioContext.close();
      } catch {
        // ignore
      }
      try {
        voiceWsRef.current?.micStream.getTracks().forEach((t) => t.stop());
      } catch {
        // ignore
      }
      voiceWsRef.current = null;
    };
  }, []);

  function parseScrapeRequest(text: string): { url: string; prompt: string; isCommand: boolean } | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith("/scrape")) {
      const match = trimmed.match(/^\/scrape\s+(\S+)(?:\s+([\s\S]*))?$/);
      if (!match) return null;
      const url = match[1] ?? "";
      const prompt = (match[2] ?? "").trim();
      return { url, prompt: prompt || "Summarize the page.", isCommand: true };
    }

    if (!webScrapeAuto) return null;
    const urlMatch = trimmed.match(/https?:\/\/[^\s<>()\]]+/i);
    if (!urlMatch) return null;
    const url = urlMatch[0].replace(/[).,]+$/, "");
    return { url, prompt: trimmed, isCommand: false };
  }

  function parsePinCommand(text: string): { url?: string; scope: "any" | "assistant" } | null {
    const normalized = text.trim().replace(/[.!?]+$/, "").trim();
    if (!normalized) return null;

    if (/^\/pin(\s+|$)/i.test(normalized)) {
      const match = normalized.match(/^\/pin(?:\s+(\S+))?/i);
      const url = (match?.[1] ?? "").trim();
      return { url: url || undefined, scope: "any" };
    }

    if (/^web pin this$/i.test(normalized) || /^pin this$/i.test(normalized)) {
      return { scope: "any" };
    }

    if (
      /^(?:web\s+)?pin\s+(?:that\s+)?(?:url|link)(?:\s+you\s+just\s+sent)?$/i.test(normalized) ||
      /^web pin that$/i.test(normalized) ||
      /^pin that$/i.test(normalized)
    ) {
      return { scope: "assistant" };
    }

    return null;
  }

  function toggleVoice() {
    if (!voiceSupported) {
      setVoiceError("Voice input is not supported in this browser.");
      return;
    }

    const recognition = recognitionRef.current;
    if (!recognition) {
      setVoiceError("Voice input is not available.");
      return;
    }

    setVoiceError(null);

    if (isListening) {
      voiceStopShouldSendRef.current = true;
      try {
        recognition.stop();
      } catch {
        // ignore
      }
      setIsListening(false);
      if (!voiceEnabled) setVoiceEnabled(true);
      return;
    }

    voiceTranscriptRef.current = "";
    voiceStopShouldSendRef.current = false;
    if (!voiceEnabled) setVoiceEnabled(true);
    try {
      recognition.start();
    } catch {
      // ignore
    }
    setIsListening(true);
  }

  function getVoiceProxyUrl() {
    if (typeof window === "undefined") return "";
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.hostname;
    return `${proto}://${host}:8787/voice`;
  }

  function toBase64(bytes: Uint8Array) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function fromBase64(base64: string) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function downsampleToRate(input: Float32Array, inputRate: number, outputRate: number) {
    if (outputRate === inputRate) return input;
    const ratio = inputRate / outputRate;
    const outLength = Math.floor(input.length / ratio);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const srcIndex = i * ratio;
      const srcLow = Math.floor(srcIndex);
      const srcHigh = Math.min(input.length - 1, srcLow + 1);
      const t = srcIndex - srcLow;
      out[i] = input[srcLow] * (1 - t) + input[srcHigh] * t;
    }
    return out;
  }

  function floatToPcm16(input: Float32Array) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      const s = Math.max(-1, Math.min(1, input[i] ?? 0));
      out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    }
    return out;
  }

  function playPcm16(audioContext: AudioContext, pcm16: Int16Array, sampleRate: number, state: VoiceWsSession) {
    const float = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i += 1) float[i] = pcm16[i] / 32768;
    const buffer = audioContext.createBuffer(1, float.length, sampleRate);
    buffer.getChannelData(0).set(float);
    const src = audioContext.createBufferSource();
    src.buffer = buffer;
    src.connect(audioContext.destination);
    const startAt = Math.max(audioContext.currentTime, state.nextPlayTime);
    src.start(startAt);
    state.nextPlayTime = startAt + buffer.duration;
  }

  function cleanupVoiceWs() {
    const session = voiceWsRef.current;
    voiceWsRef.current = null;
    try {
      session?.ws.close();
    } catch {
      // ignore
    }
    try {
      session?.processor.disconnect();
      session?.source.disconnect();
      session?.silentGain.disconnect();
    } catch {
      // ignore
    }
    try {
      void session?.audioContext.close();
    } catch {
      // ignore
    }
    try {
      session?.micStream.getTracks().forEach((t) => t.stop());
    } catch {
      // ignore
    }
  }

  function setVoiceSessionPhase(next: "idle" | "connecting" | "recording" | "responding" | "error") {
    voiceSessionPhaseRef.current = next;
    setVoiceSessionStatus(next);
  }

  async function startVoiceWsSession() {
    if (typeof window === "undefined") return;
    if (isVoiceSessionActive) return;

    setVoiceSessionError(null);
    setVoiceSessionPhase("connecting");
    setIsVoiceSessionActive(true);

    try {
      // Avoid overlapping voice systems
      try {
        recognitionRef.current?.abort();
      } catch {
        // ignore
      }
      setIsListening(false);
      window.speechSynthesis?.cancel();

      const ws = new WebSocket(getVoiceProxyUrl());
      ws.binaryType = "arraybuffer";

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);

      const session: VoiceWsSession = {
        ws,
        micStream: stream,
        audioContext,
        source,
        processor,
        silentGain,
        nextPlayTime: audioContext.currentTime,
      };
      voiceWsRef.current = session;
      voiceWsClosingRef.current = false;

      const OUTPUT_RATE = 24000;

      ws.onopen = () => {
        setVoiceSessionPhase("recording");

        // Attempt OpenAI-style realtime session config (xAI may be compatible).
        const sessionUpdate = {
          type: "session.update",
          session: {
            instructions: systemPrompt || undefined,
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: { type: "server_vad" },
          },
        };
        try {
          ws.send(JSON.stringify(sessionUpdate));
        } catch {
          // ignore
        }
      };

      ws.onmessage = (event) => {
        if (voiceWsClosingRef.current) return;
        if (typeof event.data !== "string") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data) as unknown;
        } catch {
          return;
        }
        if (!isRecord(parsed)) return;
        const type = parsed.type;
        if (type === "error") {
          const err = typeof parsed.error === "string" ? parsed.error : "Voice session error.";
          setVoiceSessionError(err);
          setVoiceSessionPhase("error");
          return;
        }

        if (type === "response.audio.delta" || type === "response.output_audio.delta") {
          const delta = (parsed.delta ?? (isRecord(parsed.audio) ? parsed.audio.delta : null)) as unknown;
          if (typeof delta !== "string") return;
          const bytes = fromBase64(delta);
          const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
          playPcm16(audioContext, pcm16, OUTPUT_RATE, session);
          return;
        }

        if (type === "response.done" || type === "response.completed") {
          voiceWsClosingRef.current = true;
          setVoiceSessionPhase("idle");
          setIsVoiceSessionActive(false);
          cleanupVoiceWs();
        }
      };

      ws.onerror = () => {
        setVoiceSessionError("Voice websocket error.");
        setVoiceSessionPhase("error");
        setIsVoiceSessionActive(false);
        voiceWsClosingRef.current = true;
        cleanupVoiceWs();
      };

      ws.onclose = () => {
        if (voiceWsClosingRef.current) return;
        setIsVoiceSessionActive(false);
        setVoiceSessionPhase("idle");
        cleanupVoiceWs();
      };

      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (voiceSessionPhaseRef.current !== "recording") return;
        const input = e.inputBuffer.getChannelData(0);
        const down = downsampleToRate(input, audioContext.sampleRate, OUTPUT_RATE);
        const pcm16 = floatToPcm16(down);
        const bytes = new Uint8Array(pcm16.buffer);
        const audio = toBase64(bytes);
        const msg = { type: "input_audio_buffer.append", audio };
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          // ignore
        }
      };
    } catch (e) {
      setVoiceSessionError(e instanceof Error ? e.message : "Voice session failed.");
      setVoiceSessionPhase("error");
      setIsVoiceSessionActive(false);
      voiceWsClosingRef.current = true;
      cleanupVoiceWs();
    }
  }

  function stopVoiceWsSession() {
    const session = voiceWsRef.current;
    if (!session) return;

    setVoiceSessionPhase("responding");

    try {
      session.processor.disconnect();
      session.source.disconnect();
      session.silentGain.disconnect();
    } catch {
      // ignore
    }
    try {
      session.micStream.getTracks().forEach((t) => t.stop());
    } catch {
      // ignore
    }

    try {
      session.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      session.ws.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio", "text"] } }));
    } catch {
      // ignore
    }

    window.setTimeout(() => {
      if (!voiceWsRef.current) return;
      voiceWsClosingRef.current = true;
      cleanupVoiceWs();
      setIsVoiceSessionActive(false);
      setVoiceSessionPhase("idle");
    }, 15000);
  }

  function toggleVoiceWsSession() {
    if (voiceSessionPhaseRef.current === "recording") {
      stopVoiceWsSession();
      return;
    }
    startVoiceWsSession().catch(() => {});
  }

  function speak(text: string) {
    if (!voiceEnabled) return;
    if (typeof window === "undefined") return;
    const synth = window.speechSynthesis;
    if (!synth) return;
    try {
      synth.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.0;
      utter.pitch = 1.0;
      utter.volume = 1.0;
      synth.speak(utter);
    } catch {
      // ignore
    }
  }

  async function send(override?: unknown) {
    const raw = typeof override === "string" ? override.trim() : draft.trim();
    if (!raw || isSending) return;

    const pinCommand = parsePinCommand(raw);
    if (pinCommand) {
      const maybeUrl = pinCommand.url?.trim();
      const source = maybeUrl
        ? { url: maybeUrl, context: maybeUrl }
        : findLatestUrl(messages, pinCommand.scope === "assistant" ? { role: "assistant" } : undefined);
      const userMsg: ChatMessage = { id: uid(), role: "user", content: raw };
      if (!source?.url) {
        const assistantMsg: ChatMessage = {
          id: uid(),
          role: "assistant",
          content:
            "No URL found to pin. Send a link, then say “web pin this”, or use `/pin https://…`.",
        };
        setMessages((prev) => [...prev, userMsg, assistantMsg]);
        setDraft("");
        return;
      }

      const normalized = normalizePinUrl(source.url);
      if (!normalized) {
        const assistantMsg: ChatMessage = {
          id: uid(),
          role: "assistant",
          content: "That doesn’t look like a valid web URL. Use a full `https://` link.",
        };
        setMessages((prev) => [...prev, userMsg, assistantMsg]);
        setDraft("");
        return;
      }

      addPinFrom(normalized, source.context);
      const assistantMsg: ChatMessage = {
        id: uid(),
        role: "assistant",
        content: "Pinned.",
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setDraft("");
      return;
    }

    const scrapeRequest = webScrapeEnabled ? parseScrapeRequest(raw) : null;
    const contentForModel = scrapeRequest?.prompt ?? raw;
    const contentForUi =
      scrapeRequest && scrapeRequest.isCommand ? contentForModel : raw;

    setError(null);
    setDraft("");
    setIsSending(true);

    const userMsg: ChatMessage = { id: uid(), role: "user", content: contentForUi };
    const placeholder: ChatMessage = {
      id: uid(),
      role: "assistant",
      content: "…",
    };

    setMessages((prev) => [...prev, userMsg, placeholder]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      let outgoingMessages: Array<{ role: Role; content: string }> = [...apiMessages];
      const contextMessage: { role: Role; content: string } = {
        role: "system",
        content: workspaceContextForModel,
      };
      const insertAt = outgoingMessages.length && outgoingMessages[0].role === "system" ? 1 : 0;
      outgoingMessages.splice(insertAt, 0, contextMessage);
      outgoingMessages.push({ role: "user", content: contentForModel });

      if (scrapeRequest?.url) {
        setMessages((prev) =>
          prev.map((m) => (m.id === placeholder.id ? { ...m, content: "Scraping…" } : m)),
        );

        const scrapeRes = await fetch("/api/scrape", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: scrapeRequest.url }),
          signal: controller.signal,
        });

        const scrapeJson = (await scrapeRes.json().catch(() => null)) as
          | { ok: true; url: string; markdown: string }
          | { ok: false; error: string }
          | null;

        if (!scrapeRes.ok || !scrapeJson || scrapeJson.ok === false) {
          const message = (scrapeJson && "error" in scrapeJson && scrapeJson.error) || "Scrape failed";
          setError(message);
        } else {
          const context = `Webpage content (via Firecrawl)\nURL: ${scrapeJson.url}\n\n${scrapeJson.markdown}`;
          outgoingMessages = [
            ...apiMessages,
            { role: "system", content: context },
            { role: "user", content: contentForModel },
          ];
        }

        setMessages((prev) =>
          prev.map((m) => (m.id === placeholder.id ? { ...m, content: "…" } : m)),
        );
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          temperature,
          messages: outgoingMessages,
          tools: {
            firecrawl: webScrapeEnabled,
            github: githubEnabled,
            githubRepo,
            todoistToken,
          },
        }),
        signal: controller.signal,
      });

      const data = (await res.json()) as ApiResponse;
      if (!res.ok || !data || data.ok === false) {
        throw new Error(
          (data && "error" in data && data.error) || `Request failed (${res.status})`,
        );
      }

      setMessages((prev) =>
        prev.map((m) => (m.id === placeholder.id ? { ...m, content: data.message.content } : m)),
      );
      speak(data.message.content);
      if (todoistEnabled) void refreshTodoistTasks();
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== placeholder.id));
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      abortRef.current = null;
      setIsSending(false);
    }
  }

  sendRef.current = send;

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsSending(false);
  }

  function clearChat() {
    setMessages([
      {
        id: uid(),
        role: "assistant",
        content:
          "Memory wiped. New session. What are we building or debugging?",
      },
    ]);
    setError(null);
  }

  function addProject() {
    const name = newProjectName.trim();
    if (!name) return;
    const id = uid();
    setProjects((prev) => [...prev, { id, name }]);
    setTasksByProject((prev) => ({ ...prev, [id]: prev[id] ?? [] }));
    setActiveProjectId(id);
    setNewProjectName("");
  }

  function addTask() {
    const title = newTaskTitle.trim();
    if (!title) return;
    if (todoistEnabled) {
      const original = newTaskTitle;
      setNewTaskTitle("");
      void (async () => {
        try {
          const res = await fetch("/api/todoist/tasks", {
            method: "POST",
            headers: {
              authorization: `Bearer ${todoistToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ content: title, labels: [TODOIST_TASK_LABEL] }),
          });

          const data = (await res.json().catch(() => null)) as
            | { ok: true; task: TodoistSidebarTask }
            | { ok: false; error: string }
            | null;

          if (!res.ok || !data || data.ok === false) {
            const message = (data && "error" in data && data.error) || `Todoist request failed (${res.status})`;
            throw new Error(message);
          }

          setTodoistTasks((prev) => [data.task, ...prev]);
          setTodoistTasksError(null);
        } catch (e) {
          setNewTaskTitle(original);
          setError(e instanceof Error ? e.message : "Todoist request failed.");
        } finally {
          void refreshTodoistTasks();
        }
      })();
      return;
    }
    const task: Task = { id: uid(), title, completed: false };
    setTasksByProject((prev) => {
      const list = prev[activeProjectId] ?? [];
      return { ...prev, [activeProjectId]: [...list, task] };
    });
    setNewTaskTitle("");
  }

  function toggleTaskCompleted(taskId: string) {
    if (todoistEnabled) {
      void (async () => {
        try {
          const res = await fetch(`/api/todoist/tasks/${encodeURIComponent(taskId)}/close`, {
            method: "POST",
            headers: { authorization: `Bearer ${todoistToken}` },
          });
          const data = (await res.json().catch(() => null)) as
            | { ok: true }
            | { ok: false; error: string }
            | null;
          if (!res.ok || !data || data.ok === false) {
            const message = (data && "error" in data && data.error) || `Todoist request failed (${res.status})`;
            throw new Error(message);
          }
          setTodoistTasks((prev) => prev.filter((t) => t.id !== taskId));
          setTodoistTasksError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Todoist request failed.");
        } finally {
          void refreshTodoistTasks();
        }
      })();
      return;
    }
    setTasksByProject((prev) => {
      const list = prev[activeProjectId] ?? [];
      return {
        ...prev,
        [activeProjectId]: list.map((t) => (t.id === taskId ? { ...t, completed: !t.completed } : t)),
      };
    });
  }

  function removeTask(taskId: string) {
    if (todoistEnabled) {
      void (async () => {
        try {
          const res = await fetch(`/api/todoist/tasks/${encodeURIComponent(taskId)}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${todoistToken}` },
          });
          const data = (await res.json().catch(() => null)) as
            | { ok: true }
            | { ok: false; error: string }
            | null;
          if (!res.ok || !data || data.ok === false) {
            const message = (data && "error" in data && data.error) || `Todoist request failed (${res.status})`;
            throw new Error(message);
          }
          setTodoistTasks((prev) => prev.filter((t) => t.id !== taskId));
          setTodoistTasksError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Todoist request failed.");
        } finally {
          void refreshTodoistTasks();
        }
      })();
      return;
    }
    setTasksByProject((prev) => {
      const list = prev[activeProjectId] ?? [];
      return { ...prev, [activeProjectId]: list.filter((t) => t.id !== taskId) };
    });
  }

  function addPinFrom(url: string, context: string) {
    const normalized = normalizePinUrl(url);
    if (!normalized) {
      setError("Invalid pin URL. Use a full https:// link.");
      return;
    }
    const baseTitle = extractMarkdownLinkTitle(context, url) ?? context;
    const titleCandidate = toFiveWords(baseTitle);
    const title = titleCandidate || toFiveWords(titleFromUrl(normalized)) || "Web pin";
    const pin: WebPin = { id: uid(), url: normalized, title, createdAt: Date.now() };
    setPinsByProject((prev) => {
      const list = prev[activeProjectId] ?? [];
      return { ...prev, [activeProjectId]: [...list, pin] };
    });
  }

  function addPinFromInput() {
    const url = newPinUrl.trim();
    if (!url) return;
    const normalized = normalizePinUrl(url);
    if (!normalized) {
      setError("Invalid pin URL. Use a full https:// link.");
      return;
    }
    addPinFrom(normalized, url);
    setNewPinUrl("");
  }

  function removePin(pinId: string) {
    setPinsByProject((prev) => {
      const list = prev[activeProjectId] ?? [];
      return { ...prev, [activeProjectId]: list.filter((p) => p.id !== pinId) };
    });
  }

  function movePinWithinActive(dragId: string, overId: string) {
    if (dragId === overId) return;
    setPinsByProject((prev) => {
      const list = prev[activeProjectId] ?? [];
      const from = list.findIndex((p) => p.id === dragId);
      const to = list.findIndex((p) => p.id === overId);
      if (from === -1 || to === -1) return prev;
      const next = list.slice();
      const [picked] = next.splice(from, 1);
      next.splice(to, 0, picked);
      return { ...prev, [activeProjectId]: next };
    });
  }

  function moveTaskWithinActive(dragId: string, overId: string) {
    if (todoistEnabled) return;
    if (dragId === overId) return;
    setTasksByProject((prev) => {
      const list = prev[activeProjectId] ?? [];
      const from = list.findIndex((t) => t.id === dragId);
      const to = list.findIndex((t) => t.id === overId);
      if (from === -1 || to === -1) return prev;
      const next = list.slice();
      const [picked] = next.splice(from, 1);
      next.splice(to, 0, picked);
      return { ...prev, [activeProjectId]: next };
    });
  }

  function beginResizeSidebar(e: ReactPointerEvent<HTMLDivElement>) {
    if (sidebarCollapsed) return;
    e.preventDefault();
    setIsResizingSidebar(true);

    const startCursor = document.body.style.cursor;
    const startSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const update = (clientX: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = clampInt(rect.right - clientX, 260, 520);
      setSidebarWidth(next);
    };

    update(e.clientX);

    const onMove = (ev: PointerEvent) => update(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = startCursor;
      document.body.style.userSelect = startSelect;
      setIsResizingSidebar(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

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

  const activeTasks = todoistEnabled ? todoistTasks : tasksByProject[activeProjectId] ?? [];
  const activePins = pinsByProject[activeProjectId] ?? [];
  const activeProjectName = projects.find((p) => p.id === activeProjectId)?.name ?? "Inbox";
  const hasUserMessage = messages.some((m) => m.role === "user");

  return (
    <div className="jarvis-bg h-dvh overflow-hidden" data-theme={theme}>
      <GalaxyBackground enabled={theme === "galaxy"} />
      <div
        ref={containerRef}
        className="relative z-10 mx-auto flex h-full w-full max-w-7xl gap-0 px-4 py-0"
      >
        {sidebarCollapsed ? (
          <button
            type="button"
            className="jarvis-sidebar-handle"
            onClick={() => setSidebarCollapsed(false)}
            aria-label="Open sidebar"
            title="Open sidebar"
          >
            ☰
          </button>
        ) : null}

        <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
          <div className="jarvis-chat-underlay" aria-hidden="true">
            <div className="jarvis-chat-underlay-inner">
              <svg
                className="jarvis-tesla-icon"
                viewBox="0 0 100 100"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <circle
                  cx="50"
                  cy="50"
                  r="44"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  opacity="0.55"
                />
                <path
                  d="M55 24H29.5c-2.2 0-4 1.8-4 4v.7c0 2.2 1.8 4 4 4h8.3V72c0 2.8 2.2 5 5 5h2.4c2.8 0 5-2.2 5-5V32.7H55c2.2 0 4-1.8 4-4V28c0-2.2-1.8-4-4-4Z"
                  fill="currentColor"
                  opacity="0.45"
                />
                <path
                  d="M63.5 35.5 56 46l6.2 2.4-9.9 15.8 1.8-12.1-6.3-2.4 8.7-14.2Z"
                  fill="currentColor"
                  opacity="0.55"
                />
                <path
                  d="M31 78.5c6.9 4.5 13.7 6.7 20.4 6.7 6.8 0 13.3-2.1 19.6-6.4"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  opacity="0.40"
                  strokeLinecap="round"
                />
              </svg>
              <div className="jarvis-tesla-quote">
                <div className="jarvis-tesla-quote-text">
                  “The present is theirs; the future, for which I really worked, is mine.”
                </div>
                <div className="jarvis-tesla-quote-attrib">— Nikola Tesla</div>
              </div>
            </div>
          </div>

          <section className="relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-8 md:px-8">
            {hasUserMessage ? (
              <div className="mx-auto w-full max-w-[860px] space-y-8">
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={
                      m.role === "user"
                        ? "group flex flex-row-reverse items-start justify-start gap-3"
                        : "group flex gap-4"
                    }
                  >
                    <div
                      className={
                        m.role === "assistant"
                          ? "jarvis-avatar jarvis-avatar-assistant"
                          : "jarvis-avatar jarvis-avatar-user"
                      }
                      aria-hidden="true"
                    >
                      {m.role === "assistant" ? "G" : "Y"}
                    </div>

                    <div
                      className={
                        m.role === "user"
                          ? "flex min-w-0 max-w-[720px] flex-col items-end"
                          : "min-w-0 flex-1"
                      }
                    >
                      <div
                        className={
                          m.role === "user"
                            ? "mb-2 flex w-full items-center justify-end gap-2"
                            : "mb-2 flex items-center justify-between gap-2"
                        }
                      >
                        <div
                          className={
                            m.role === "user"
                              ? "text-right text-[12px] font-medium text-[color:var(--jarvis-muted)]"
                              : "text-[12px] font-medium text-[color:var(--jarvis-muted)]"
                          }
                        >
                          {m.role === "assistant" ? "Grok" : "You"}
                        </div>
                        <button
                          type="button"
                          className="jarvis-icon-button opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={() => navigator.clipboard.writeText(m.content).catch(() => {})}
                          aria-label="Copy message"
                          title="Copy"
                        >
                          ⧉
                        </button>
                      </div>

                      <div
                        className={
                          m.role === "assistant"
                            ? "jarvis-bubble jarvis-bubble-assistant"
                            : "jarvis-bubble jarvis-bubble-user w-fit max-w-[720px]"
                        }
                      >
                        <div className="jarvis-prose whitespace-pre-wrap text-[15px] leading-7 text-[color:var(--jarvis-text)]">
                          {m.content}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            ) : (
              <div className="mx-auto flex h-full w-full max-w-[860px] flex-col justify-center pb-10">
                <div className="jarvis-hero">
                  <div className="jarvis-hero-title">How can I help today?</div>
                  <div className="jarvis-hero-sub">
                    Grok inside Pat • Model <span className="jarvis-hero-pill">{model}</span>
                  </div>
                </div>

                <div className="mt-8">
                  <div className="jarvis-composer">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          send();
                        }
                      }}
                      rows={4}
                      placeholder="Ask anything…"
                      className="jarvis-composer-textarea"
                    />
                    <div className="jarvis-composer-bar">
                      <div className="jarvis-composer-left">
                        <button type="button" className="jarvis-composer-icon" disabled title="Coming soon">
                          +
                        </button>
                        <button type="button" className="jarvis-composer-icon" disabled title="Coming soon">
                          ⏱
                        </button>
                        <button
                          type="button"
                          onClick={toggleVoice}
                          className="jarvis-composer-icon"
                          data-active={isListening ? "true" : "false"}
                          aria-pressed={isListening}
                          aria-label={isListening ? "Stop listening and send" : "Start voice input"}
                          title={
                            !voiceSupported
                              ? "Voice not supported"
                              : isListening
                                ? "Stop (send)"
                                : "Speak"
                          }
                          disabled={!voiceSupported}
                        >
                          {isListening ? "■" : "⏺"}
                        </button>
                        <button
                          type="button"
                          onClick={toggleVoiceWsSession}
                          className="jarvis-composer-icon"
                          data-active={voiceSessionStatus === "recording" ? "true" : "false"}
                          aria-pressed={voiceSessionStatus === "recording"}
                          aria-label={
                            voiceSessionStatus === "recording"
                              ? "Stop voice and get response"
                              : "Start voice session"
                          }
                          title={
                            voiceSessionStatus === "recording"
                              ? "Stop (respond)"
                              : "Voice-to-voice (WebSocket)"
                          }
                        >
                          🗣
                        </button>
                      </div>
                      <div className="jarvis-composer-right">
                        <Link href="/dag" className="jarvis-button h-10 px-4" title="Canvas">
                          Cnavas
                        </Link>
                        <Link
                          href="/settings"
                          className="jarvis-composer-icon"
                          aria-label="Configuration"
                          title="Configuration"
                        >
                          ⚙
                        </Link>
                        {isSending ? (
                          <button type="button" onClick={stop} className="jarvis-button h-10 px-4">
                            Stop
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={send}
                          disabled={isSending || !draft.trim()}
                          className="jarvis-send-round"
                          aria-label="Send"
                          title="Send"
                        >
                          ↑
                        </button>
                      </div>
                    </div>
                    {voiceError ? <div className="jarvis-error mt-3 text-sm">{voiceError}</div> : null}
                    {voiceSessionError ? (
                      <div className="jarvis-error mt-3 text-sm">{voiceSessionError}</div>
                    ) : null}
                    {error ? <div className="jarvis-error mt-3 text-sm">{error}</div> : null}
                  </div>
                </div>
              </div>
            )}
          </section>

          {hasUserMessage ? (
            <footer className="relative z-10 px-6 py-4 md:px-8">
              {error ? (
                <div className="jarvis-error mb-3 text-sm">
                  {error}
                  <div className="mt-1 text-[12px] text-[color:var(--jarvis-muted)]">
                    Ensure `XAI_API_KEY` is set in `pat/.env.local`.
                  </div>
                </div>
              ) : null}

              <div className="mx-auto w-full max-w-[860px]">
                <div className="jarvis-composer">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    rows={2}
                    placeholder="Message Grok…"
                    className="jarvis-composer-textarea"
                  />
                  <div className="jarvis-composer-bar">
                    <div className="jarvis-composer-left">
                      <button type="button" className="jarvis-composer-icon" disabled title="Coming soon">
                        +
                      </button>
                      <button type="button" className="jarvis-composer-icon" disabled title="Coming soon">
                        ⏱
                      </button>
                      <button
                        type="button"
                        onClick={toggleVoice}
                        className="jarvis-composer-icon"
                        data-active={isListening ? "true" : "false"}
                        aria-pressed={isListening}
                        aria-label={isListening ? "Stop listening and send" : "Start voice input"}
                        title={
                          !voiceSupported
                            ? "Voice not supported"
                            : isListening
                              ? "Stop (send)"
                              : "Speak"
                        }
                        disabled={!voiceSupported}
                      >
                        {isListening ? "■" : "⏺"}
                      </button>
                      <button
                        type="button"
                        onClick={toggleVoiceWsSession}
                        className="jarvis-composer-icon"
                        data-active={voiceSessionStatus === "recording" ? "true" : "false"}
                        aria-pressed={voiceSessionStatus === "recording"}
                        aria-label={
                          voiceSessionStatus === "recording"
                            ? "Stop voice and get response"
                            : "Start voice session"
                        }
                        title={
                          voiceSessionStatus === "recording"
                            ? "Stop (respond)"
                            : "Voice-to-voice (WebSocket)"
                        }
                      >
                        🗣
                      </button>
                    </div>
                    <div className="jarvis-composer-right">
                      <div className="jarvis-composer-meta" title={model}>
                        {model}
                      </div>
                      <Link href="/dag" className="jarvis-button h-10 px-4" title="Canvas">
                        Cnavas
                      </Link>
                      <Link
                        href="/settings"
                        className="jarvis-composer-icon"
                        aria-label="Configuration"
                        title="Configuration"
                      >
                        ⚙
                      </Link>
                      {isSending ? (
                        <button type="button" onClick={stop} className="jarvis-button h-10 px-4">
                          Stop
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={send}
                        disabled={isSending || !draft.trim()}
                        className="jarvis-send-round"
                        aria-label="Send"
                        title="Send"
                      >
                        ↑
                      </button>
                    </div>
                  </div>
                </div>
                {voiceError ? <div className="jarvis-error mt-3 text-sm">{voiceError}</div> : null}
                {voiceSessionError ? (
                  <div className="jarvis-error mt-3 text-sm">{voiceSessionError}</div>
                ) : null}
              </div>
            </footer>
          ) : null}
        </main>

        <aside
          data-collapsed={sidebarCollapsed ? "true" : "false"}
          className={`jarvis-panel jarvis-right-sidebar hidden h-full shrink-0 overflow-hidden md:flex md:flex-col ${
            sidebarCollapsed ? "md:ml-0" : "md:ml-4"
          }`}
          style={{ width: sidebarCollapsed ? 0 : `${sidebarWidth}px` }}
        >
            <div
              className={isResizingSidebar ? "jarvis-sidebar-resize jarvis-sidebar-resize-active" : "jarvis-sidebar-resize"}
              onPointerDown={beginResizeSidebar}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
            />
            <div className="flex items-center justify-between px-3 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <div className="jarvis-logo" aria-hidden="true">
                  P
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[color:var(--jarvis-text)]">
                    Pat
                  </div>
                  <div className="truncate text-[12px] text-[color:var(--jarvis-muted)]">
                    Projects • Tasks
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="jarvis-icon-button"
                onClick={() => setSidebarCollapsed(true)}
                aria-label="Close sidebar"
                title="Close sidebar"
                >
                  ×
                </button>
            </div>

            <div className="jarvis-divider" />

            <div className="min-h-0 flex-1 overflow-hidden px-4 py-4">
              <div className="flex h-full flex-col gap-4">
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="text-[12px] font-medium text-[color:var(--jarvis-muted)]">
                        Model
                      </div>
                      <button
                        type="button"
                        className="jarvis-icon-button"
                        onClick={() => setModelOpen((v) => !v)}
                        aria-label={modelOpen ? "Collapse model" : "Expand model"}
                        title={modelOpen ? "Collapse" : "Expand"}
                        aria-expanded={modelOpen}
                      >
                        {modelOpen ? "–" : "+"}
                      </button>
                    </div>

                    <div className="jarvis-collapsible" data-open={modelOpen ? "true" : "false"}>
                      <div className="pt-2">
                        <select
                          value={model}
                          onChange={(e) => setModel(e.target.value)}
                          className="jarvis-input h-10 w-full px-3 text-[13px]"
                          aria-label="Model"
                        >
                          {modelOptions.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="text-[12px] font-medium text-[color:var(--jarvis-muted)]">
                        Projects
                      </div>
                      <button
                        type="button"
                        className="jarvis-icon-button"
                        onClick={() => setProjectsOpen((v) => !v)}
                        aria-label={projectsOpen ? "Collapse projects" : "Expand projects"}
                        title={projectsOpen ? "Collapse" : "Expand"}
                      >
                        {projectsOpen ? "–" : "+"}
                      </button>
                    </div>

                    {projectsOpen ? (
                      <div className="space-y-3">
                        <div className="space-y-2">
                          {projects.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => setActiveProjectId(p.id)}
                              className={
                                p.id === activeProjectId
                                  ? "jarvis-list-item jarvis-list-item-active"
                                  : "jarvis-list-item"
                              }
                            >
                              <span className="truncate">{p.name}</span>
                            </button>
                          ))}
                        </div>

                        <div className="flex gap-2">
                          <input
                            value={newProjectName}
                            onChange={(e) => setNewProjectName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") addProject();
                            }}
                            placeholder="New project…"
                            className="jarvis-input h-10 min-w-0 flex-1 px-3 text-[13px]"
                          />
                          <button type="button" onClick={addProject} className="jarvis-button px-3">
                            Add
                          </button>
                        </div>
                      </div>
                    ) : null}

                    <div className="flex items-center justify-between">
                      <div className="text-[12px] font-medium text-[color:var(--jarvis-muted)]">
                        Tasks
                      </div>
                      <button
                        type="button"
                        className="jarvis-icon-button"
                        onClick={() => setTasksOpen((v) => !v)}
                        aria-label={tasksOpen ? "Collapse tasks" : "Expand tasks"}
                        title={tasksOpen ? "Collapse" : "Expand"}
                        aria-expanded={tasksOpen}
                      >
                        {tasksOpen ? "–" : "+"}
                      </button>
                    </div>

                    <div className="jarvis-collapsible" data-open={tasksOpen ? "true" : "false"}>
                      <div className="space-y-3 pt-1">
                        <div
                          className="jarvis-active-project"
                          title={
                            todoistEnabled
                              ? `Todoist tasks (label: ${TODOIST_TASK_LABEL})`
                              : `Active project: ${activeProjectName}`
                          }
                        >
                          <span className="jarvis-active-project-label">
                            {todoistEnabled ? "Todoist" : "Active"}
                          </span>
                          <span className="jarvis-active-project-name">
                            {todoistEnabled ? `Label: ${TODOIST_TASK_LABEL}` : activeProjectName}
                          </span>
                        </div>

                        <div className="space-y-2">
                          {todoistEnabled && todoistTasksLoading ? (
                            <div className="text-[12px] text-[color:var(--jarvis-muted)]">
                              Syncing Todoist…
                            </div>
                          ) : null}

                          {todoistEnabled && todoistTasksError ? (
                            <div className="jarvis-error text-sm">{todoistTasksError}</div>
                          ) : null}

                          {activeTasks.length ? (
                            activeTasks.map((t) => (
                              <div
                                key={t.id}
                                className={
                                  dragTaskId === t.id
                                    ? "jarvis-task-item jarvis-task-item-dragging"
                                    : "jarvis-task-item"
                                }
                                draggable={!todoistEnabled}
                                onDragStart={(e) => {
                                  if (todoistEnabled) return;
                                  setDragTaskId(t.id);
                                  e.dataTransfer.effectAllowed = "move";
                                  e.dataTransfer.setData("text/plain", t.id);
                                }}
                                onDragEnd={() => setDragTaskId(null)}
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  e.dataTransfer.dropEffect = "move";
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  const dragged = e.dataTransfer.getData("text/plain") || dragTaskId;
                                  if (dragged) moveTaskWithinActive(dragged, t.id);
                                  setDragTaskId(null);
                                }}
                              >
                                <button
                                  type="button"
                                  className="jarvis-task-check"
                                  onClick={() => toggleTaskCompleted(t.id)}
                                  aria-label={
                                    todoistEnabled
                                      ? "Complete Todoist task"
                                      : t.completed
                                          ? "Mark task as not completed"
                                          : "Mark task as completed"
                                  }
                                  title={todoistEnabled ? "Complete in Todoist" : t.completed ? "Uncomplete" : "Complete"}
                                >
                                  {t.completed ? "✓" : "○"}
                                </button>

                                <div
                                  className={
                                    t.completed
                                      ? "jarvis-task-title jarvis-task-title-completed"
                                      : "jarvis-task-title"
                                  }
                                  title={t.title}
                                >
                                  {t.title}
                                </div>
                                <button
                                  type="button"
                                  className="jarvis-icon-button jarvis-task-remove"
                                  onClick={() => removeTask(t.id)}
                                  aria-label={todoistEnabled ? "Delete Todoist task" : "Remove task"}
                                  title={todoistEnabled ? "Delete" : "Remove"}
                                >
                                  ×
                                </button>
                              </div>
                            ))
                          ) : (
                            <div className="text-[12px] text-[color:var(--jarvis-muted)]">
                              {todoistEnabled
                                ? todoistTasksLoading || todoistTasksError
                                    ? ""
                                    : `No Todoist tasks labeled “${TODOIST_TASK_LABEL}”.`
                                : "No tasks yet."}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="text-[12px] font-medium text-[color:var(--jarvis-muted)]">
                        Web Pins
                      </div>
                      <button
                        type="button"
                        className="jarvis-icon-button"
                        onClick={() => setPinsOpen((v) => !v)}
                        aria-label={pinsOpen ? "Collapse web pins" : "Expand web pins"}
                        title={pinsOpen ? "Collapse" : "Expand"}
                        aria-expanded={pinsOpen}
                      >
                        {pinsOpen ? "–" : "+"}
                      </button>
                    </div>

                    <div className="jarvis-collapsible" data-open={pinsOpen ? "true" : "false"}>
                      <div className="space-y-2 pt-1">
                        {activePins.length ? (
                          activePins.map((p) => (
                            <div
                              key={p.id}
                              className={
                                dragPinId === p.id
                                  ? "jarvis-pin-item jarvis-pin-item-dragging"
                                  : "jarvis-pin-item"
                              }
                              draggable
                              onDragStart={(e) => {
                                setDragPinId(p.id);
                                e.dataTransfer.effectAllowed = "move";
                                e.dataTransfer.setData("text/plain", p.id);
                              }}
                              onDragEnd={() => setDragPinId(null)}
                              onDragOver={(e) => {
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "move";
                              }}
                              onDrop={(e) => {
                                e.preventDefault();
                                const dragged = e.dataTransfer.getData("text/plain") || dragPinId;
                                if (dragged) movePinWithinActive(dragged, p.id);
                                setDragPinId(null);
                              }}
                            >
                              <button
                                type="button"
                                className="jarvis-pin-open"
                                onClick={() => window.open(p.url, "_blank", "noopener,noreferrer")}
                                aria-label="Open web pin"
                                title={p.url}
                              >
                                ↗
                              </button>
                              <div className="jarvis-pin-title" title={p.title}>
                                {p.title}
                              </div>
                              <button
                                type="button"
                                className="jarvis-icon-button jarvis-pin-remove"
                                onClick={() => removePin(p.id)}
                                aria-label="Remove web pin"
                                title="Remove"
                              >
                                ×
                              </button>
                            </div>
                          ))
                        ) : (
                          <div className="text-[12px] text-[color:var(--jarvis-muted)]">
                            No web pins yet.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-auto space-y-3">
                  <div className="jarvis-collapsible" data-open={tasksOpen ? "true" : "false"}>
                    <div className="flex gap-2 pt-2">
                      <input
                        value={newTaskTitle}
                        onChange={(e) => setNewTaskTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addTask();
                        }}
                        placeholder={todoistEnabled ? "New Todoist task…" : `New task in ${activeProjectName}…`}
                        className="jarvis-input h-10 min-w-0 flex-1 px-3 text-[13px]"
                      />
                      <button type="button" onClick={addTask} className="jarvis-button px-3">
                        Add
                      </button>
                    </div>
                  </div>

                  <div className="jarvis-collapsible" data-open={pinsOpen ? "true" : "false"}>
                    <div className="flex gap-2 pt-2">
                      <input
                        value={newPinUrl}
                        onChange={(e) => setNewPinUrl(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addPinFromInput();
                        }}
                        placeholder="Pin URL…"
                        className="jarvis-input h-10 min-w-0 flex-1 px-3 text-[13px]"
                      />
                      <button type="button" onClick={addPinFromInput} className="jarvis-button px-3">
                        Add
                      </button>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Link href="/settings" className="jarvis-link-button flex-1">
                      Configuration
                    </Link>
                    <button type="button" onClick={clearChat} className="jarvis-button flex-1">
                      Clear
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </aside>
      </div>
    </div>
  );
}
