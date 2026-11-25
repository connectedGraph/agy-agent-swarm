import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 生产交付为自包含的 .next/standalone/server.js，不依赖 next start
  output: "standalone",
  serverExternalPackages: ["@earendil-works/pi-coding-agent"],
  // 开发时用 127.0.0.1 / localhost 都能正常 hydration 和 HMR
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  devIndicators: false,
  // 运行时目录与仓库元数据不进交付产物：data/ 有任务快照、worktree 和上游 key，
  // dist/ 是旧构建产物，.git/ 是仓库历史。
  // 注意不要写 "./server/**" 这类与 .next/server 同名的规则：
  // Turbopack 的 ignore 按路径段匹配，会把 .next/server/chunks 一起剔掉。
  outputFileTracingExcludes: {
    "/*": [
      "./.git/**",
      "./data/**",
      "./dist/**",
      "./docs/**",
      "./tools/**",
      "./deploy/**",
      "./*.md",
      "./install.sh",
      "./tsconfig*.json",
      "./tsconfig.tsbuildinfo",
      "./postcss.config.mjs",
      "./pnpm-lock.yaml",
    ],
  },
};
export default nextConfig;
