export const dynamic = "force-dynamic";

// 给 CLI 和部署脚本用的轻量探针：返回进程标识与根目录，便于确认连的是哪一份服务。
// 不暴露会话/任务内容；那些由 /api/chats、/api/tasks 提供。
export async function GET() {
  return Response.json({
    ok: true,
    app: "agy-agent-swarm",
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    appRoot: process.env.SWARM_APP_ROOT || process.cwd(),
    now: Date.now(),
  });
}
