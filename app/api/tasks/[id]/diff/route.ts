import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getTask } from "@/server/store";

export const dynamic = "force-dynamic";

function diff(dir: string): string {
  if (!dir || !existsSync(dir)) return "";
  try {
    execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
    return execFileSync("git", ["-C", dir, "diff", "--cached", "--stat"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  const agents = task.agents.map((a) => ({
    id: a.id,
    name: a.name,
    branch: a.branch,
    worktree: a.worktree,
    files: a.changedFiles,
    stat: diff(a.worktree),
  }));
  return Response.json({ agents });
}
