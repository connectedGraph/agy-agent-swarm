import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "agy swarm · Antigravity Agent Swarm",
  description: "编排、沙箱、验证并合并 agy ACP 代理的执行结果",
};

// 在首帧之前定主题，避免闪白 / 闪黑
const themeBoot = `(function(){try{var t=localStorage.getItem("swarm-theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
