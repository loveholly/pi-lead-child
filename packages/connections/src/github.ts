// GitHub 的令牌来源。GitHub 的远程 MCP 不支持 DCR，也不支持 CIMD（2026-10-16 读过它的元数据），
// 所以按顺序试三种：
// 1. 复用这台 Mac 上 gh 的登录：每次要用时运行 `gh auth token`，daemon 不存这个令牌，续期由 gh 负责。
// 2. 设备码：用配置里的 GitHub OAuth App client ID。设备流程不需要 client secret，也不需要回调地址。
//    OAuth App 的令牌不过期（一年不用会被吊销），所以没有续期问题。
// 3. 粘贴 PAT。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { FetchLike } from "./oauth.js";

export interface GhTokenSource {
  // 返回 gh 当前登录的令牌；没装 gh、没登录或者超时时返回 null。不抛错，不打日志。
  token(): Promise<string | null>;
}

// launchd 启动的 daemon 的 PATH 往往没有 Homebrew 的目录，所以另外看几个常见位置。
const GH_LOCATIONS = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];

export function findGh(path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "gh");
    if (existsSync(candidate)) return candidate;
  }
  return GH_LOCATIONS.find((candidate) => existsSync(candidate)) ?? null;
}

export function ghCliTokenSource(options: { bin?: string | null; timeoutMs?: number } = {}): GhTokenSource {
  return {
    token() {
      const bin = options.bin === undefined ? findGh() : options.bin;
      if (!bin) return Promise.resolve(null);
      return new Promise((resolve) => {
        execFile(bin, ["auth", "token", "--hostname", "github.com"], {
          timeout: options.timeoutMs ?? 5_000, maxBuffer: 64 * 1024, encoding: "utf8",
          env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
        }, (error, stdout) => {
          const token = typeof stdout === "string" ? stdout.trim() : "";
          resolve(!error && /^[A-Za-z0-9_]{20,255}$/.test(token) ? token : null);
        });
      });
    },
  };
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export const GITHUB_DEVICE_SCOPE = "repo read:org";

export async function startDeviceFlow(fetchImpl: FetchLike, clientId: string, scope = GITHUB_DEVICE_SCOPE): Promise<DeviceCode> {
  const response = await fetchImpl("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    throw new Error(`GitHub did not start the device flow: ${typeof body.error === "string" ? body.error : `HTTP ${response.status}`}`);
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: typeof body.verification_uri === "string" ? body.verification_uri : "https://github.com/login/device",
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 900,
    interval: typeof body.interval === "number" ? body.interval : 5,
  };
}

export type DevicePoll =
  | { state: "pending"; interval: number }
  | { state: "done"; accessToken: string; scope: string | null }
  | { state: "failed"; reason: "expired" | "denied" | "error"; message: string };

export async function pollDeviceFlow(fetchImpl: FetchLike, clientId: string, code: DeviceCode, interval: number): Promise<DevicePoll> {
  let response: Response;
  try {
    response = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId, device_code: code.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // 网络断了：下一轮再问。
    return { state: "pending", interval };
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.access_token === "string" && body.access_token) {
    return { state: "done", accessToken: body.access_token, scope: typeof body.scope === "string" ? body.scope : null };
  }
  switch (body.error) {
    case "authorization_pending": return { state: "pending", interval };
    case "slow_down": return { state: "pending", interval: typeof body.interval === "number" ? body.interval : interval + 5 };
    case "expired_token": return { state: "failed", reason: "expired", message: "设备码过期了，请重新连接" };
    case "access_denied": return { state: "failed", reason: "denied", message: "你在 GitHub 上拒绝了授权" };
    default: return { state: "failed", reason: "error", message: `GitHub 返回了 ${typeof body.error === "string" ? body.error : `HTTP ${response.status}`}` };
  }
}

// 令牌对应的 GitHub 账号，用来显示「@login」。拿不到时返回 null。
export async function githubLogin(fetchImpl: FetchLike, token: string): Promise<string | null> {
  try {
    const response = await fetchImpl("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "pi-lead-child" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { login?: unknown };
    return typeof body.login === "string" ? `@${body.login}` : null;
  } catch {
    return null;
  }
}
