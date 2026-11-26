// 跨站写请求防护：只拦截 /api/* 的非 GET/HEAD 请求。
// 说明：Next 16.4 已把 middleware 文件约定标记为 deprecated（正式名 proxy.ts，导出名 proxy），
// 但本版本仍识别 middleware.ts 的 middleware 导出，API 与 proxy 一致，因此沿用该文件名。
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 本机来源：localhost / 127.0.0.1 / [::1]，端口不限（URL.hostname 对 IPv6 会带方括号）
function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

// 从 Host 头取 hostname，兼容 "127.0.0.1:3100" 和 "[::1]:3100" 两种写法
function hostnameOfHost(host: string | null): string | null {
  if (!host) return null;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Origin 合法条件：本机来源，或与请求 Host 的 hostname 相同（端口不参与比较）
function isAllowedOrigin(origin: string, reqHostname: string | null): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    // "null"（沙箱 iframe）以及畸形 Origin 一律拒绝
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (isLocalHostname(u.hostname)) return true;
  return !!reqHostname && u.hostname.toLowerCase() === reqHostname;
}

function forbid(message: string) {
  return NextResponse.json({ error: "forbidden", message }, { status: 403 });
}

export function middleware(request: NextRequest) {
  const method = request.method.toUpperCase();
  // 只关心写操作；GET/HEAD 直接放行（包括 SSE 的 /api/stream）
  if (method === "GET" || method === "HEAD") return;

  const origin = request.headers.get("origin");
  const secFetchSite = request.headers.get("sec-fetch-site");
  // Host 头在某些运行时可能被过滤，用 nextUrl.hostname 兜底（同样来自请求 URL）
  const reqHostname = hostnameOfHost(request.headers.get("host")) ?? (request.nextUrl.hostname.toLowerCase() || null);

  if (origin) {
    // 有 Origin 就必须合法：本机来源，或与请求 Host 的 hostname 一致
    if (!isAllowedOrigin(origin, reqHostname)) return forbid("已拒绝跨站写请求");
    return;
  }

  // 没有 Origin：curl、脚本、agent 调用放行；
  // 但浏览器明确标记 cross-site / same-site 时说明是网页发起，仍拒绝，避免绕过
  if (secFetchSite === "cross-site" || secFetchSite === "same-site") {
    return forbid("已拒绝跨站写请求");
  }
  return;
}

// 只匹配 /api 下的全部路径；GET /api/stream 不受影响
export const config = {
  matcher: "/api/:path*",
};
