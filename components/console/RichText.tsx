"use client";

import type { ReactNode } from "react";

/* 轻量 Markdown 渲染：只处理验证器 / 修复代理报告里真实出现的语法
   标题、有序/无序列表、加粗、行内代码、链接、代码块。
   不做 HTML 注入，链接只显示文字并把地址放进 title。 */

function inline(text: string, keyBase: string): ReactNode[] {
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("**")) {
      out.push(
        <strong key={key} style={{ fontWeight: 600, color: "var(--ink)" }}>
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("`")) {
      out.push(
        <code key={key} className="rich-code">
          {tok.slice(1, -1)}
        </code>,
      );
    } else {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (mm) {
        out.push(
          <span key={key} className="rich-link" title={mm[2]}>
            {mm[1]}
          </span>,
        );
      } else {
        out.push(tok);
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let code: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      if (code) {
        blocks.push(
          <pre key={`c${i}`} className="rich-pre">
            {code.join("\n")}
          </pre>,
        );
        code = null;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) continue;

    const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(
        <div key={i} className="rich-h">
          {inline(h[1], `h${i}`)}
        </div>,
      );
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<div key={i} className="rich-rule" />);
      continue;
    }

    const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ol) {
      blocks.push(
        <div key={i} className="rich-li">
          <span className="rich-mk num">{ol[1]}.</span>
          <span>{inline(ol[2], `o${i}`)}</span>
        </div>,
      );
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      blocks.push(
        <div key={i} className="rich-li">
          <span className="rich-mk">·</span>
          <span>{inline(ul[1], `u${i}`)}</span>
        </div>,
      );
      continue;
    }

    blocks.push(
      <p key={i} className="rich-p">
        {inline(line, `p${i}`)}
      </p>,
    );
  }

  if (code) {
    blocks.push(
      <pre key="c-end" className="rich-pre">
        {code.join("\n")}
      </pre>,
    );
  }

  return <div className="rich">{blocks}</div>;
}
