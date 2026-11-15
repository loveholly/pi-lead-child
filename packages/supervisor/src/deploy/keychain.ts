import { execFile, execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// 这些 key 会进 process.env，child 都能拿到。只给 daemon 用的 key（例如决策模型的 TYPESAFE_API_KEY）不放这里：
// daemon 用 readKeychainSecret 直接读（apps/daemon 的 memory-controller.ts）。
// 沙箱里的命令只看到占位值，发往绑定的主机时代理才换成真值（core 的 sandbox-policy.ts）。
// NPM_TOKEN（2026-10-29）：用户的 ~/.npmrc 用 ${NPM_TOKEN} 给 registry.npmjs.org 认证，值在钥匙串里（dev-secret:NPM_TOKEN），
// 用户的终端靠 .zshrc 调 security 读出来。沙箱读不了钥匙串，变量是空的，npm 和 pnpm 读 .npmrc 就报错，#159 装不上依赖。
export const KEYCHAIN_ENV_KEYS = ["AM_API_KEY", "TAVILY_API_KEY", "NPM_TOKEN"] as const;

export function keychainServiceName(key: string): string {
  return `dev-secret:${key}`;
}

// 给用户照抄的写入命令（doctor 和 install 的提示）。只用 macOS 自带的 security，不依赖别的脚本。
// -w 放最后、不带值：security 交互式提示输入，命令里和 shell 历史里都不出现明文。-U 表示已有时覆盖。
export function keychainSetCommand(key: string): string {
  return `security add-generic-password -U -a "$USER" -s "${keychainServiceName(key)}" -w`;
}

export function keychainSecretExists(key: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("security", [
      "find-generic-password",
      "-a", userInfo().username,
      "-s", keychainServiceName(key),
    ], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// 读一个 dev-secret:<key>，不写进 process.env。给 daemon 自己用的密钥（例如 PLC_SLACK_CLIENT_SECRET）：
// 它们不能进环境，因为 child 继承 daemon 的全部环境。没有时返回 null。
// 它在请求路径上（SmartModel、记忆设置），所以最多等 3 秒：Keychain 锁着弹出授权框时不能卡住 daemon。
export function readKeychainSecret(key: string): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const value = execFileSync("security", [
      "find-generic-password",
      "-a", userInfo().username,
      "-s", keychainServiceName(key),
      "-w",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3_000 }).trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * readKeychainSecret 的异步版：security 在子进程里跑，不占住 daemon 的主线程。daemon 的 Keychain 缓存过期以后用它在后台刷新
 * （2026-11-03）。同样最多等 3 秒；没有时、超时时返回 null。
 */
export async function readKeychainSecretAsync(key: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-a", userInfo().username,
      "-s", keychainServiceName(key),
      "-w",
    ], { encoding: "utf8", timeout: 3_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function loadKeychainEnv(
  keys: readonly string[] = KEYCHAIN_ENV_KEYS,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (process.platform !== "darwin") return [];
  const loaded: string[] = [];
  for (const key of keys) {
    if (env[key]) continue;
    try {
      const value = execFileSync("security", [
        "find-generic-password",
        "-a", userInfo().username,
        "-s", keychainServiceName(key),
        "-w",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (!value) continue;
      env[key] = value;
      loaded.push(key);
    } catch {
      // Optional secrets may be absent. Installation preflight owns required-key reporting.
    }
  }
  return loaded;
}

