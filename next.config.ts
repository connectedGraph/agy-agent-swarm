import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@earendil-works/pi-coding-agent"],
  // 开发时用 127.0.0.1 / localhost 都能正常 hydration 和 HMR
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  devIndicators: false,
};
export default nextConfig;
