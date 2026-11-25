import { createChat, listChats, sendChatMessage } from "@/server/chats";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ chats: listChats() });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as any));
  const text = String(body?.text || "").trim();
  const chat = createChat({ repoPath: body?.repoPath });
  try {
    if (text) await sendChatMessage(chat, text);
    return Response.json({ chat });
  } catch (e: any) {
    return Response.json({ chat, error: e?.message || String(e) }, { status: 500 });
  }
}
