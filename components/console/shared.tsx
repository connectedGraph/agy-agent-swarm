import type { Tone } from "@/components/ui/kit";
import type { AgentRun } from "@/lib/types";

export const STATE_LABEL: Record<string, string> = {
  queued: "排队",
  booting: "启动",
  working: "执行中",
  done: "完成",
  failed: "失败",
  planning: "规划中",
  running: "集群执行",
  merging: "合并中",
  verifying: "验证中",
  rework: "返工中",
  aggregating: "汇总中",
  idle: "待命",
};

export const STATE_TONE: Record<string, Tone> = {
  queued: "neutral",
  booting: "accent",
  working: "accent",
  done: "ok",
  failed: "bad",
  planning: "warn",
  running: "accent",
  merging: "accent",
  verifying: "accent",
  rework: "warn",
  aggregating: "accent",
  idle: "neutral",
};

const LIVE = new Set(["booting", "working", "planning", "running", "merging", "verifying", "rework", "aggregating"]);

export function isLive(state: string) {
  return LIVE.has(state);
}

export function fmt(n?: number | null) {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

export function dur(ms?: number | null) {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return ms + " ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + " s";
  return Math.floor(ms / 60000) + " m " + Math.floor((ms % 60000) / 1000) + " s";
}

export function usageTotal(a: AgentRun) {
  return a.spent || a.usage?.totalTokens || (a.usage?.inputTokens || 0) + (a.usage?.outputTokens || 0);
}

export function clock(ts?: number | null) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 历史任务里保存的是旧的角色名，展示层统一到当前术语，不改写原始记录
export function sysText(s: string) {
  return s
    .replace(/包工头/g, "编排器")
    .replace(/工人/g, "执行代理")
    .replace(/修复者/g, "修复代理")
    .replace(/验证者/g, "验证器")
    .replace(/合并后验收失败/g, "合并后自动检查失败")
    .replace(/契约验收/g, "契约检查")
    .replace(/验收未通过/g, "验证未通过")
    .replace(/验收命令/g, "检查命令");
}

// 卡片里的文本预览：
// 运行中的代理看最新进度（尾部），已结束的代理看开头（有完整句子，不会从半个 URL 开始）
// 预览一律去掉 Markdown 记号，卡片里只留人话
export function preview(text: string, max: number, live = false) {
  if (!text) return "";
  const plain = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "");
  if (live && plain.length > max) {
    const cut = plain.slice(-max);
    const nl = cut.indexOf("\n");
    return "…" + (nl >= 0 ? cut.slice(nl + 1) : cut).trim();
  }
  const cut = plain.length > max;
  const head = cut ? plain.slice(0, max) : plain;
  const nl = head.lastIndexOf("\n");
  const out = (nl > max * 0.5 ? head.slice(0, nl) : head).trim();
  return cut ? out + "…" : out;
}
