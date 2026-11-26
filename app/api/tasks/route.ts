import { listTasks } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ tasks: listTasks() });
}

// 执行只能从会话触发（POST /api/chats/:id/run）
export async function POST() {
  return Response.json(
    { error: "执行入口已收敛到会话：请先创建会话，再 POST /api/chats/:id/run" },
    { status: 410 },
  );
}
