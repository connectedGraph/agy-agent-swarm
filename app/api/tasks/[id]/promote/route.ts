import { promoteTask } from "@/server/orchestrator";
import { getTask } from "@/server/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => ({} as any));
  const result = promoteTask(task, !!body?.force);
  return Response.json({ promote: result, task });
}
