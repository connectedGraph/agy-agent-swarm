import { ChatBusyError, getChat, startChatTask } from "@/server/chats";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const chat = getChat(id);
  if (!chat) return Response.json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => ({} as any));
  try {
    const task = startChatTask(chat, { agents: body?.agents, goal: body?.goal });
    return Response.json({ task, chat });
  } catch (e: any) {
    const status = e instanceof ChatBusyError || e?.code === "BUSY" ? 409 : 400;
    return Response.json({ error: e?.message || String(e) }, { status });
  }
}
