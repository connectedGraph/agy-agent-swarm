"use client";

import { useState } from "react";
import type { Chat, Task } from "@/lib/types";
import { Dot, Icon, IconBtn, ThemeToggle } from "@/components/ui/kit";
import { BrandMark } from "@/components/console/Header";
import { displayState, fmt, fullTime, relTime } from "@/components/console/shared";
import { Confirm, Modal } from "./Confirm";

function projectName(repoPath: string | null) {
  if (!repoPath) return "默认工作区";
  const parts = repoPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || repoPath;
}

export function Sidebar({
  chats,
  tasks,
  currentId,
  now,
  narrow,
  open,
  onNew,
  onSelect,
  onRename,
  onDelete,
  onClose,
  connected,
  gw,
  onToggleRecord,
}: {
  chats: Chat[];
  tasks: Task[];
  currentId: string | null;
  now: number;
  // 窄屏（<=820px）时侧栏是抽屉：open 控制滑入，narrow 用来切换 aria/inert
  narrow: boolean;
  open: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<string | null>;
  onDelete: (id: string, withTasks: boolean) => Promise<string | null>;
  onClose?: () => void;
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

  // 重命名
  const [renameChat, setRenameChat] = useState<Chat | null>(null);
  const [renameText, setRenameText] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameErr, setRenameErr] = useState("");

  // 删除会话
  const [delChat, setDelChat] = useState<Chat | null>(null);
  const [withTasks, setWithTasks] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState("");

  function openRename(c: Chat) {
    setRenameChat(c);
    setRenameText(c.title);
    setRenameErr("");
  }

  async function doRename() {
    if (!renameChat || renameBusy) return;
    const text = renameText.trim();
    if (!text) {
      setRenameErr("标题不能为空");
      return;
    }
    setRenameBusy(true);
    setRenameErr("");
    const err = await onRename(renameChat.id, text.slice(0, 60));
    setRenameBusy(false);
    if (err) setRenameErr(err);
    else setRenameChat(null);
  }

  function openDelete(c: Chat) {
    setDelChat(c);
    setWithTasks(false);
    setDelErr("");
  }

  async function doDelete() {
    if (!delChat || delBusy) return;
    setDelBusy(true);
    setDelErr("");
    const err = await onDelete(delChat.id, withTasks);
    setDelBusy(false);
    if (err) setDelErr(err);
    else setDelChat(null);
  }

  // 侧栏只显示最近一次任务的状态；历史任务里的都按 displayState 判定
  function latestOf(c: Chat): Task | undefined {
    const ids = c.taskIds?.length ? c.taskIds : c.taskId ? [c.taskId] : [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const t = byId.get(ids[i]);
      if (t) return t;
    }
    return undefined;
  }

  return (
    <aside
      className="chat-side"
      id="chat-side"
      data-open={open}
      tabIndex={-1}
      aria-label="会话列表"
      aria-hidden={narrow && !open ? true : undefined}
      inert={narrow && !open}
    >
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
        {onClose && (
          <IconBtn
            className="side-close"
            label="关闭会话列表"
            icon={<Icon name="close" size={15} />}
            onClick={onClose}
          />
        )}
      </div>

      <div style={{ padding: "6px 10px 8px" }}>
        <button className="nav-new" onClick={onNew} aria-label="新建会话" title="新建会话">
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
              const task = latestOf(c);
              const ds = task ? displayState(task) : null;
              return (
                <div
                  key={c.id}
                  className="side-item"
                  data-active={c.id === currentId}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(c.id);
                    }
                  }}
                  aria-label={`打开会话：${c.title}`}
                  aria-current={c.id === currentId ? "true" : undefined}
                  title={c.title}
                >
                  <span style={{ paddingTop: 6, flex: "none" }}>
                    <Dot tone={ds ? ds.tone : "neutral"} live={ds ? ds.live : false} />
                  </span>
                  <span className="side-item-body">
                    <span className="side-item-title">{c.title}</span>
                    <span className="side-item-meta">
                      {ds ? ds.label : "对话中"}
                      <span>·</span>
                      <span title={fullTime(c.updatedAt)}>{relTime(c.updatedAt, now)}</span>
                      {task && task.totalUsage > 0 && (
                        <>
                          <span>·</span>
                          {fmt(task.totalUsage)}
                        </>
                      )}
                    </span>
                  </span>
                  <span
                    className="side-item-actions"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <IconBtn
                      className="side-action"
                      label={`重命名会话：${c.title}`}
                      icon={<Icon name="pencil" size={13} />}
                      onClick={() => openRename(c)}
                    />
                    <IconBtn
                      className="side-action"
                      label={`删除会话：${c.title}`}
                      icon={<Icon name="trash" size={13} />}
                      onClick={() => openDelete(c)}
                    />
                  </span>
                </div>
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

      {renameChat && (
        <Modal
          title="重命名会话"
          onClose={() => {
            if (!renameBusy) setRenameChat(null);
          }}
          footer={
            <>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => setRenameChat(null)}
                disabled={renameBusy}
                aria-label="取消重命名"
                title="取消重命名"
              >
                取消
              </button>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => void doRename()}
                disabled={renameBusy}
                aria-label="保存会话标题"
                title="保存会话标题"
              >
                保存
              </button>
            </>
          }
        >
          <div className="modal-field">
            <label className="modal-label" htmlFor="rename-chat">
              会话标题
            </label>
            <input
              id="rename-chat"
              className="modal-input"
              value={renameText}
              maxLength={60}
              onChange={(e) => setRenameText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void doRename();
              }}
              autoFocus
            />
            <div className="modal-hint">最多 60 字</div>
          </div>
          {renameErr && (
            <div className="modal-error" role="alert">
              {renameErr}
            </div>
          )}
        </Modal>
      )}

      {delChat && (
        <Confirm
          title="删除会话"
          tone="danger"
          confirmLabel="删除"
          busy={delBusy}
          error={delErr}
          onConfirm={() => void doDelete()}
          onClose={() => setDelChat(null)}
          message={
            <>
              确定删除会话「{delChat.title}」？会话记录与对话消息会被移除，此操作不可撤销。
            </>
          }
        >
          <label className="modal-check">
            <input
              type="checkbox"
              checked={withTasks}
              onChange={(e) => setWithTasks(e.target.checked)}
              aria-label="同时删除历史任务"
            />
            <span>同时删除历史任务（worktree 与运行目录）</span>
          </label>
          <div className="modal-hint">会话里还有执行中的任务时会拒绝删除，请先停止。</div>
        </Confirm>
      )}
    </aside>
  );
}
