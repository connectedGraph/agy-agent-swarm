import { cancelTask, isTaskLive } from "@/server/orchestrator";
import { getTask } from "@/server/store";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  if (!isTaskLive(task)) {
    return Response.json({ error: "任务已结束，无需取消", state: task.state }, { status: 409 });
  }
  const cancelled = cancelTask(id);
  return Response.json({ task: cancelled });
}
