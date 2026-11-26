import { deleteChat, getChat, updateChat } from "@/server/chats";
import { cleanupTask, isTaskActive } from "@/server/orchestrator";
import { getTask } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const chat = getChat(id);
  if (!chat) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ chat });
}

// 只允许改标题与目标仓库；其它字段一律忽略，避免前端误改任务绑定
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const chat = getChat(id);
  if (!chat) return Response.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({} as any));
  const patch: { title?: string; repoPath?: string | null } = {};
  if (typeof body?.title === "string") patch.title = body.title;
  if (body && Object.prototype.hasOwnProperty.call(body, "repoPath")) {
    if (body.repoPath !== null && typeof body.repoPath !== "string") {
      return Response.json({ error: "repoPath 必须是字符串或 null" }, { status: 400 });
    }
    patch.repoPath = body.repoPath;
  }
  if (!Object.keys(patch).length) {
    return Response.json({ error: "没有可更新的字段" }, { status: 400 });
  }

  const next = updateChat(id, patch);
  if (!next) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ chat: next });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const chat = getChat(id);
  if (!chat) return Response.json({ error: "not found" }, { status: 404 });

  const withTasks = new URL(req.url).searchParams.get("withTasks") === "1";
  const ids = chat.taskIds?.length ? chat.taskIds : chat.taskId ? [chat.taskId] : [];
  const tasks = ids.map((tid) => getTask(tid)).filter(Boolean);
  const live = tasks.filter((t) => isTaskActive(t!));

  // 有任务在跑就整体拒绝，避免删掉会话后任务还在后台烧 token
  if (live.length) {
    return Response.json(
      { error: "会话还有任务在执行或收尾，先取消或等它结束", taskIds: live.map((t) => t!.id) },
      { status: 409 },
    );
  }

  const deletedTasks: string[] = [];
  if (withTasks) {
    for (const t of tasks) {
      if (cleanupTask(t!.id)) deletedTasks.push(t!.id);
    }
  }
  deleteChat(id);
  return Response.json({ ok: true, id, deletedTasks });
}
