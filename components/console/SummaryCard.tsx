"use client";

import { Card } from "@/components/ui/kit";
import type { Task } from "@/lib/types";

export function SummaryCard({ task }: { task: Task }) {
  if (!task.summary) return null;

  return (
    <Card style={{ padding: 18 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: "var(--ink-3)",
          letterSpacing: "0.04em",
        }}
      >
        编排器汇总
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 13,
          lineHeight: 1.75,
          color: "var(--ink)",
          whiteSpace: "pre-wrap",
        }}
      >
        {task.summary}
      </div>
    </Card>
  );
}
