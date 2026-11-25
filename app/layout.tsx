import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Swarm · Agent 集群编排",
  description: "包工头 + agy ACP 子代理集群控制台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
