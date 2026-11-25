"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Card, Dot, Icon, IconBtn } from "@/components/ui/kit";
import type { AgentRun } from "@/lib/types";
import { RichText } from "./RichText";
import { STATE_LABEL, STATE_TONE, isLive } from "./shared";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--ink-3)", letterSpacing: "0.02em" }}>{title}</div>
      <div style={{ marginTop: 5 }}>{children}</div>
    </div>
  );
}

export function AgentDetail({ agent, onClose }: { agent: AgentRun; onClose: () => void }) {
  const tone = STATE_TONE[agent.state] || "neutral";
  const live = isLive(agent.state);
  const files = agent.changedFiles || [];
  const shownFiles = files.slice(0, 4).join(", ");
  const extraFiles = files.length - 4;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [agent.id]);

  return (
    <div ref={ref}>
    <Card className="fade-up" style={{ padding: 18 }}>
      <div className="flex items-center" style={{ gap: 8, minWidth: 0 }}>
        <span
          className="truncate"
          style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.008em", minWidth: 0 }}
        >
          {agent.name}
        </span>
        <span
          className="flex items-center flex-none"
          style={{ gap: 6, fontSize: 11, color: "var(--ink-3)" }}
        >
          <Dot tone={tone} live={live} />
          {STATE_LABEL[agent.state] || agent.state}
        </span>
        <IconBtn
          label="关闭"
          onClick={onClose}
          icon={<Icon name="close" size={16} />}
          style={{ marginLeft: "auto", flex: "none" }}
        />
      </div>

      {agent.task && (
        <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--ink-2)", marginTop: 8 }}>
          {agent.task}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
        {agent.scope?.length > 0 && (
          <Section title="允许改动">
            <div
              className="code"
              style={{ whiteSpace: "normal", overflowWrap: "anywhere", lineHeight: 1.7 }}
            >
              {agent.scope.join(" · ")}
            </div>
          </Section>
        )}

        {agent.acceptance?.length > 0 && (
          <Section title="验收标准">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {agent.acceptance.map((item, i) => (
                <div key={i} className="flex" style={{ gap: 8, alignItems: "flex-start" }}>
                  <span
                    style={{
                      width: 4,
                      height: 4,
                      borderRadius: 999,
                      background: "var(--ink-4)",
                      flex: "none",
                      marginTop: 7,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      lineHeight: 1.6,
                      color: "var(--ink-2)",
                      minWidth: 0,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {item}
                  </span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {agent.worktree && (
          <Section title="工作目录">
            <div
              className="code line-clamp-2"
              title={agent.worktree}
              style={{ overflowWrap: "anywhere", lineHeight: 1.7 }}
            >
              {agent.worktree}
            </div>
          </Section>
        )}

        {files.length > 0 && (
          <Section title="改动文件">
            <div className="code" style={{ overflowWrap: "anywhere", lineHeight: 1.7 }}>
              {shownFiles}
              {extraFiles > 0 ? ` +${extraFiles}` : ""}
            </div>
          </Section>
        )}

        {agent.text && (
          <Section title="输出">
            <div style={{ maxHeight: 260, overflowY: "auto", paddingRight: 2 }}>
              <RichText text={agent.text} />
            </div>
          </Section>
        )}
      </div>
    </Card>
    </div>
  );
}
