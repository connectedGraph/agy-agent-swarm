import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { getTask } from "@/server/store";
import type { AgentRun } from "@/lib/types";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

// 只读 git 查询：带超时和输出上限，失败一律退化为空结果，不把 500 抛给 UI
async function gitRead(dir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      // --no-optional-locks：连索引刷新这类后台写都不做，保证 GET 真正无副作用
      ["--no-optional-locks", "-C", dir, ...args],
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
    );
    return stdout;
  } catch {
    return null;
  }
}

// 解析 `git status --porcelain --untracked-files=all`：
// 每行前两位是状态码，第 4 个字符起是路径；重命名/复制取箭头后的新路径
function parsePorcelain(out: string): { files: string[]; untracked: string[] } {
  const files: string[] = [];
  const untracked: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    path = path.trim();
    // 含特殊字符的路径会被 git 加上双引号，去掉外层引号即可（不做八进制反转义，保持只读够用）
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (!path) continue;
    files.push(path);
    if (code === "??") untracked.push(path);
  }
  return { files, untracked };
}

// 单个 agent worktree 的只读快照
async function inspectAgent(agent: AgentRun) {
  const base = {
    // 保留原有 UI 字段
    id: agent.id,
    name: agent.name,
    branch: agent.branch,
    worktree: agent.worktree,
    // worktree 已被回收时退回落库的改动快照，避免详情页空白
    files: agent.changedFiles,
    committed: false,
    stat: "",
    untracked: { count: 0, files: [] as string[] },
  };

  if (!agent.worktree || !existsSync(agent.worktree)) return base;

  const [status, stat] = await Promise.all([
    gitRead(agent.worktree, ["status", "--porcelain", "--untracked-files=all"]),
    gitRead(agent.worktree, ["diff", "--stat", "HEAD"]),
  ]);

  // git 查询失败：stat 为空字符串，files 保留快照，不抛错
  if (status === null) return { ...base, stat: stat ?? "" };

  const { files, untracked } = parsePorcelain(status);
  // 代理可能已经自行提交，工作区是干净的；这时用落库的改动列表兜底，
  // 否则界面/CLI 会把「改动已提交」显示成「没有改动」。
  const effective = files.length ? files : agent.changedFiles;
  return {
    ...base,
    files: effective,
    committed: files.length === 0 && agent.changedFiles.length > 0,
    stat: stat ?? "",
    untracked: { count: untracked.length, files: untracked },
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  // 并发查询各 worktree，全部只读，不改 index、不写工作区
  const agents = await Promise.all(task.agents.map((a) => inspectAgent(a)));
  return Response.json({ agents });
}
