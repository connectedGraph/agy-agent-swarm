import { sendBossMessage } from "@/server/orchestrator";
import { getTask } from "@/server/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return Response.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({} as any));
  try {
    const message = await sendBossMessage(task, String(body?.text || ""));
    return Response.json({ message, task });
  } catch (e: any) {
    return Response.json({ error: e?.message || String(e) }, { status: 400 });
  }
}
