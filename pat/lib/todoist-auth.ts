export function getTodoistTokenFromRequest(req: Request) {
  const header = req.headers.get("authorization") || req.headers.get("x-todoist-token") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = (match?.[1] ?? header).trim();
  return token || null;
}

