"use client";

import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";

/* ---------------- 语义色 ---------------- */

export type Tone = "neutral" | "accent" | "ok" | "bad" | "warn";

export const TONE_VAR: Record<Tone, string> = {
  neutral: "var(--ink-4)",
  accent: "var(--accent)",
  ok: "var(--ok)",
  bad: "var(--bad)",
  warn: "var(--warn)",
};

const TAG_TONE: Record<Tone, string> = {
  neutral: "tag",
  accent: "tag tag-accent",
  ok: "tag tag-ok",
  bad: "tag tag-bad",
  warn: "tag tag-warn",
};

/* ---------------- 图标 ---------------- */

const ICONS = {
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20.4 14.2A8.5 8.5 0 0 1 9.8 3.6a8.5 8.5 0 1 0 10.6 10.6Z" />,
  branch: (
    <>
      <circle cx="6.5" cy="5.5" r="1.8" />
      <circle cx="6.5" cy="18.5" r="1.8" />
      <circle cx="17.5" cy="7.5" r="1.8" />
      <path d="M6.5 7.3v9.4M8.3 6.1h3.2a6 6 0 0 1 6 6v-3" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  alert: (
    <>
      <path d="M12 3.5 21 19.5H3L12 3.5Z" />
      <path d="M12 9.5v4M12 16.5v.01" />
    </>
  ),
  spinner: <path d="M12 3a9 9 0 1 0 9 9" />,
  plus: <path d="M12 5v14M5 12h14" />,
  // 纸飞机：发送语义，替代原来表意不清的对勾
  send: <path d="m4 12 16-8-6 16-2.7-6.3L4 12Zm7.3 1.7L20 4" />,
  pencil: (
    <>
      <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="m13.5 6.5 4 4" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  // 会话列表抽屉
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  // 执行代理栏开关
  panel: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M15 4.5v15" />
    </>
  ),
  // 回到底部
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 16,
  className = "",
  strokeWidth = 1.6,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {ICONS[name]}
    </svg>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Icon name="spinner" size={size} className="animate-spin" strokeWidth={2} />;
}

/* ---------------- 容器 ---------------- */

export function Card({
  className = "",
  quiet = false,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { quiet?: boolean }) {
  return (
    <div className={`${quiet ? "card-quiet" : "card"} ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function Divider({ className = "" }: { className?: string }) {
  return <div className={`divider ${className}`} role="separator" />;
}

/* ---------------- 点 / 标签 ---------------- */

export function Dot({
  tone = "neutral",
  live = false,
  style,
}: {
  tone?: Tone;
  live?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={`dot ${live ? "dot-live" : ""}`}
      style={{ background: TONE_VAR[tone], color: TONE_VAR[tone], ...style }}
    />
  );
}

export function Tag({
  tone = "neutral",
  children,
  className = "",
  mono = false,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return <span className={`${TAG_TONE[tone]} ${mono ? "mono" : ""} ${className}`}>{children}</span>;
}

/* ---------------- 按钮 ---------------- */

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
  size?: "md" | "sm";
  icon?: ReactNode;
};

export function Btn({
  variant = "secondary",
  size = "md",
  icon,
  className = "",
  children,
  ...rest
}: BtnProps) {
  const cls = [
    "btn",
    variant === "primary" ? "btn-primary" : "",
    variant === "ghost" ? "btn-ghost" : "",
    variant === "danger" ? "btn btn-danger" : "",
    variant === "danger-ghost" ? "btn btn-ghost btn-danger-ghost" : "",
    size === "sm" ? "btn-sm" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={cls} {...rest}>
      {icon}
      {children}
    </button>
  );
}

export function IconBtn({
  label,
  icon,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: ReactNode }) {
  return (
    <button className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      {icon}
    </button>
  );
}

/* ---------------- 开关 ---------------- */

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="toggle"
      data-on={checked}
      onClick={() => onChange(!checked)}
    />
  );
}

/* ---------------- 计量条 ---------------- */

export function Meter({
  segments,
  height = 6,
}: {
  segments: { value: number; color: string; label?: string; opacity?: number }[];
  height?: number;
}) {
  return (
    <div className="meter" style={{ height }} role="presentation">
      {segments
        .filter((s) => s.value > 0)
        .map((s, i) => (
          <i
            key={i}
            title={s.label}
            style={{
              width: `${Math.min(100, s.value * 100)}%`,
              height: "100%",
              background: s.color,
              opacity: s.opacity,
              transition: "width 600ms var(--ease)",
            }}
          />
        ))}
    </div>
  );
}

/* ---------------- 展开 ---------------- */

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className = "",
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="disclosure flex w-full items-center gap-2 text-left"
        style={{ cursor: "pointer", background: "none", border: "none", padding: 0, color: "inherit" }}
      >
        {summary}
        <Icon
          name="chevron"
          size={12}
          className="ml-auto flex-none"
          strokeWidth={1.8}
        />
      </button>
      <div
        style={{
          display: "grid",
          gridTemplateRows: open ? "1fr" : "0fr",
          transition: "grid-template-rows var(--dur-2) var(--ease), opacity var(--dur-2) var(--ease)",
          opacity: open ? 1 : 0,
        }}
      >
        <div style={{ overflow: "hidden", minHeight: 0 }}>{children}</div>
      </div>
    </div>
  );
}

/* ---------------- 主题 ---------------- */

type Theme = "light" | "dark";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    setTheme(t === "dark" ? "dark" : "light");
  }, []);

  function flip() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    const root = document.documentElement;
    root.classList.add("theme-switching");
    root.dataset.theme = next;
    root.style.colorScheme = next;
    try {
      localStorage.setItem("swarm-theme", next);
    } catch {
      /* ignore */
    }
    setTheme(next);
    window.setTimeout(() => root.classList.remove("theme-switching"), 340);
  }

  return (
    <IconBtn
      label={theme === "dark" ? "切换到浅色" : "切换到深色"}
      onClick={flip}
      icon={<Icon name={theme === "dark" ? "sun" : "moon"} size={16} />}
      style={{ opacity: theme ? 1 : 0, transition: "opacity 200ms" }}
    />
  );
}
