"use client";

import type { Task } from "@/lib/types";
import { Dot, Icon, ThemeToggle } from "@/components/ui/kit";
import { BrandMark } from "@/components/console/Header";
import { STATE_LABEL, STATE_TONE, clock, fmt, isLive } from "@/components/console/shared";

function projectName(t: Task) {
  if (!t.repoPath) return "默认工作区";
  const parts = t.repoPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || t.repoPath;
}

export function Sidebar({
  tasks,
  currentId,
  onNew,
  onSelect,
  connected,
  gw,
  onToggleRecord,
}: {
  tasks: Task[];
  currentId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  connected: boolean;
  gw: any;
  onToggleRecord: () => void;
}) {
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = projectName(t);
    const arr = groups.get(key) || [];
    arr.push(t);
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
        {!tasks.length && (
          <div style={{ fontSize: 12, color: "var(--ink-4)", padding: "14px 10px", lineHeight: 1.7 }}>
            还没有会话。新建一个，把目标交给编排器。
          </div>
        )}
        {[...groups.entries()].map(([name, list]) => (
          <div className="side-group" key={name}>
            <div className="side-group-title">{name}</div>
            {list.map((t) => {
              const tone = STATE_TONE[t.state] || "neutral";
              return (
                <button
                  key={t.id}
                  className="side-item"
                  data-active={t.id === currentId}
                  onClick={() => onSelect(t.id)}
                  title={t.goal}
                >
                  <span style={{ paddingTop: 6, flex: "none" }}>
                    <Dot tone={tone} live={isLive(t.state)} />
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="side-item-title">{t.goal}</span>
                    <span className="side-item-meta">
                      {STATE_LABEL[t.state] || t.state}
                      <span>·</span>
                      {clock(t.createdAt)}
                      {t.totalUsage > 0 && (
                        <>
                          <span>·</span>
                          {fmt(t.totalUsage)}
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
