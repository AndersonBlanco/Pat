import { todoistDeleteTask } from "@/lib/todoist";
import { getTodoistTokenFromRequest } from "@/lib/todoist-auth";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

export async function DELETE(req: Request, ctx: { params: { taskId: string } }) {
  const token = getTodoistTokenFromRequest(req);
  if (!token) return json({ ok: false, error: "Missing Todoist token." }, { status: 401 });

  const { taskId } = ctx.params;
  const id = (taskId || "").trim();
  if (!id) return json({ ok: false, error: "Missing task id." }, { status: 400 });

  try {
    await todoistDeleteTask({ token, taskId: id });
    return json({ ok: true });
  } catch (e) {
    return json(
      { ok: false, error: e instanceof Error ? e.message : "Todoist request failed." },
      { status: 502 },
    );
  }
}
