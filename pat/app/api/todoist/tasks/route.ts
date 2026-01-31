import { todoistCreateTask, todoistListTasks, type TodoistDue } from "@/lib/todoist";
import { getTodoistTokenFromRequest } from "@/lib/todoist-auth";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

function clampNumber(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) return null;
  return value.filter((v) => typeof v === "string");
}

function labelMatches(taskLabels: string[], label: string) {
  const wanted = label.trim().toLowerCase();
  if (!wanted) return true;
  return taskLabels.some((l) => l.trim().toLowerCase() === wanted);
}

function mapDue(due: TodoistDue | null) {
  if (!due) return null;
  const cleaned: TodoistDue = {};
  if (typeof due.date === "string") cleaned.date = due.date;
  if (typeof due.datetime === "string") cleaned.datetime = due.datetime;
  if (typeof due.string === "string") cleaned.string = due.string;
  if (typeof due.timezone === "string" || due.timezone === null) cleaned.timezone = due.timezone;
  return cleaned;
}

export async function GET(req: Request) {
  const token = getTodoistTokenFromRequest(req);
  if (!token) return json({ ok: false, error: "Missing Todoist token." }, { status: 401 });

  const url = new URL(req.url);
  const label = url.searchParams.get("label")?.trim() || "";
  const filter = url.searchParams.get("filter")?.trim() || "";
  const projectId = url.searchParams.get("project_id")?.trim() || "";
  const limitEnv = Number(url.searchParams.get("limit") ?? "60");
  const limit = clampNumber(Number.isNaN(limitEnv) ? 60 : limitEnv, 1, 200);

  const fetchLimit = clampNumber(Math.max(limit, 200), 1, 500);

  try {
    const { tasks } = await todoistListTasks({
      token,
      filter: filter || undefined,
      projectId: projectId || undefined,
      maxItems: fetchLimit,
    });

    const filtered = label ? tasks.filter((t) => labelMatches(t.labels, label)) : tasks;
    const mapped = filtered.slice(0, limit).map((t) => ({
      id: t.id,
      title: t.content,
      completed: t.isCompleted,
      url: t.url,
      due: mapDue(t.due),
    }));

    return json({ ok: true, tasks: mapped, total: filtered.length });
  } catch (e) {
    return json(
      { ok: false, error: e instanceof Error ? e.message : "Todoist request failed." },
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  const token = getTodoistTokenFromRequest(req);
  if (!token) return json({ ok: false, error: "Missing Todoist token." }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isRecord(body)) return json({ ok: false, error: "Invalid JSON body." }, { status: 400 });

  const content = readString(body.content)?.trim() || "";
  if (!content) return json({ ok: false, error: "`content` is required." }, { status: 400 });

  const labels = readStringArray(body.labels) ?? undefined;
  const description = readString(body.description) ?? undefined;
  const dueString = readString(body.due_string) ?? readString(body.dueString) ?? undefined;
  const dueDate = readString(body.due_date) ?? readString(body.dueDate) ?? undefined;
  const dueDatetime = readString(body.due_datetime) ?? readString(body.dueDatetime) ?? undefined;
  const projectId = readString(body.project_id) ?? readString(body.projectId) ?? undefined;
  const priority = typeof body.priority === "number" ? body.priority : undefined;

  try {
    const task = await todoistCreateTask({
      token,
      content,
      description,
      projectId,
      labels,
      priority,
      dueString,
      dueDate,
      dueDatetime,
    });

    return json({
      ok: true,
      task: {
        id: task.id,
        title: task.content,
        completed: task.isCompleted,
        url: task.url,
        due: mapDue(task.due),
      },
    });
  } catch (e) {
    return json(
      { ok: false, error: e instanceof Error ? e.message : "Todoist request failed." },
      { status: 502 },
    );
  }
}

