"use client";

import type { Chat, Task } from "@/lib/types";
import { Dot, Icon, ThemeToggle } from "@/components/ui/kit";
import { BrandMark } from "@/components/console/Header";
import { STATE_LABEL, STATE_TONE, clock, fmt, isLive } from "@/components/console/shared";

function projectName(repoPath: string | null) {
  if (!repoPath) return "默认工作区";
  const parts = repoPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || repoPath;
}

export function Sidebar({
  chats,
  tasks,
  currentId,
  onNew,
  onSelect,
  connected,
  gw,
  onToggleRecord,
}: {
  chats: Chat[];
  tasks: Task[];
  currentId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  connected: boolean;
  gw: any;
  onToggleRecord: () => void;
}) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const groups = new Map<string, Chat[]>();
  for (const c of chats) {
    const key = projectName(c.repoPath);
    const arr = groups.get(key) || [];
    arr.push(c);
    groups.set(key, arr);
  }

  return (
    <aside className="chat-side">
      <div className="chat-side-head">
        <BrandMark size={22} />
        <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: "-0.01em" }}>agy swarm</span>
        <span
          title={connected ? "事件流已连接" : "事件流断开"}
          style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center" }}
        >
          <Dot tone={connected ? "ok" : "bad"} live={connected} />
        </span>
        <ThemeToggle />
      </div>

      <div style={{ padding: "6px 10px 8px" }}>
        <button className="nav-new" onClick={onNew}>
          <Icon name="plus" size={15} />
          新建会话
        </button>
      </div>

      <div className="chat-side-scroll">
        {!chats.length && (
          <div style={{ fontSize: 12, color: "var(--ink-4)", padding: "14px 10px", lineHeight: 1.7 }}>
            还没有会话。新建一个，先和编排器聊清楚目标。
          </div>
        )}
        {[...groups.entries()].map(([name, list]) => (
          <div className="side-group" key={name}>
            <div className="side-group-title">{name}</div>
            {list.map((c) => {
              const task = c.taskId ? byId.get(c.taskId) : undefined;
              const state = task?.state;
              const tone = state ? STATE_TONE[state] || "neutral" : "neutral";
              return (
                <button
                  key={c.id}
                  className="side-item"
                  data-active={c.id === currentId}
                  onClick={() => onSelect(c.id)}
                  title={c.title}
                >
                  <span style={{ paddingTop: 6, flex: "none" }}>
                    <Dot tone={tone} live={state ? isLive(state) : false} />
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="side-item-title">{c.title}</span>
                    <span className="side-item-meta">
                      {state ? STATE_LABEL[state] || state : "对话中"}
                      <span>·</span>
                      {clock(c.updatedAt)}
                      {task && task.totalUsage > 0 && (
                        <>
                          <span>·</span>
                          {fmt(task.totalUsage)}
                        </>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="chat-side-foot">
        <button className="side-foot-row" onClick={onToggleRecord} title="切换 API 录制">
          <Dot tone={!gw || gw.offline ? "neutral" : "ok"} />
          <span>录制网关</span>
          <span style={{ marginLeft: "auto", color: "var(--ink-3)" }}>
            {!gw || gw.offline ? "未启动" : gw.enabled ?? true ? "录制中" : "仅统计"}
          </span>
        </button>
        <div className="side-foot-row" style={{ cursor: "default" }}>
          <span style={{ color: "var(--ink-3)" }}>编排器</span>
          <span style={{ marginLeft: "auto", color: "var(--ink-3)" }}>deepseek-v4.1-flash</span>
        </div>
      </div>
    </aside>
  );
}
