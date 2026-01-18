import { cookies } from "next/headers";
import { getGitHubTokenCookieName } from "@/lib/github-auth";

export async function POST(req: Request) {
  const origin = process.env.APP_URL?.trim() || new URL(req.url).origin;
  const jar = await cookies();
  jar.delete(getGitHubTokenCookieName());
  return Response.redirect(`${origin}/settings?github=disconnected`, 302);
}

