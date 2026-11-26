import { detachTaskFromChats } from "@/server/chats";
import { cleanupTask, isTaskActive } from "@/server/orchestrator";
import { getTask } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ task });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  if (isTaskActive(task)) {
    return Response.json({ error: "任务还在执行或正在收尾，稍后再删除", state: task.state }, { status: 409 });
  }
  cleanupTask(id);
  detachTaskFromChats(id);
  return Response.json({ ok: true, id });
}
