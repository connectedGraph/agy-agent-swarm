import { getChat, sendChatMessage } from "@/server/chats";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const chat = getChat(id);
  if (!chat) return Response.json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => ({} as any));
  try {
    const message = await sendChatMessage(chat, String(body?.text || ""));
    return Response.json({ message, chat });
  } catch (e: any) {
    return Response.json({ error: e?.message || String(e) }, { status: 400 });
  }
}
