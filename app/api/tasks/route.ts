import { createTask } from "@/server/orchestrator";
import { listTasks } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ tasks: listTasks() });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const goal = String(body.goal || "").trim();
  if (!goal) return Response.json({ error: "goal 不能为空" }, { status: 400 });
  const task = createTask({
    goal,
    agents: Number(body.agents) || 3,
    repoPath: body.repoPath || undefined,
  });
  return Response.json({ task });
}
