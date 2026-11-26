import { eventsSince, listTasks, subscribeWithIds } from "@/server/store";
import { listChats } from "@/server/chats";
import type { SwarmEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let off: (() => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  // 浏览器 EventSource 断线重连时自动带 Last-Event-ID；不是纯数字就当没有
  const raw = req.headers.get("last-event-id");
  const lastId = raw && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;

  const stream = new ReadableStream({
    start(controller) {
      const writeRaw = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* closed */
        }
      };
      // 每条事件都带 id：前端重连时靠它只补发缺失的部分
      const writeEvent = (id: number, ev: SwarmEvent) => {
        writeRaw(`id: ${id}\ndata: ${JSON.stringify(ev)}\n\n`);
      };

      // 补发判定与订阅都在同一个同步块里，中间不可能插入新事件：
      // eventsSince 返回 null 表示 id 已滚出环/来自旧进程，退回全量 snapshot；
      // 有 Last-Event-ID 且能补发时不再发 snapshot，只补缺失事件后继续订阅。
      const missed = lastId !== null ? eventsSince(lastId) : null;
      if (missed) {
        for (const { id, ev } of missed) writeEvent(id, ev);
      } else {
        writeRaw(`data: ${JSON.stringify({ type: "snapshot", tasks: listTasks(), chats: listChats() })}\n\n`);
      }
      off = subscribeWithIds(writeEvent);

      ping = setInterval(() => writeRaw(": ping\n\n"), 15000);
      req.signal.addEventListener("abort", () => {
        off?.();
        off = null;
        if (ping) clearInterval(ping);
        ping = null;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      off?.();
      off = null;
      if (ping) clearInterval(ping);
      ping = null;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
