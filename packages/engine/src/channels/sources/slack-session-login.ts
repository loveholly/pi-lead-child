// Slack 浏览器会话的登录窗口（2026-11-02，.scratch/slack-session 工单 05）：拿到网页版 Slack 的会话 cookie。
//   1. 在这台电脑上启动一个独立的 Chrome：临时的配置目录（不碰用户自己的 Chrome 和它的 cookie），调试端口由 Chrome 自己选
//      （--remote-debugging-port=0，端口写在配置目录的 DevToolsActivePort 里），只听本机。打开 Slack 的登录页。
//   2. 用户在窗口里自己登录。这里每秒经调试接口（Storage.getCookies）看一次 .slack.com 的 d cookie；有了就用 gabriel-slack
//      换一次会话，换得出来才算登录成功。
//   3. 成功、超时（缺省 5 分钟）、取消、用户关掉窗口：都关掉 Chrome，删掉临时目录。
// cookie 只作为返回值交给调用方（daemon 存进保险库），不写日志，不出现在错误里。
// 浏览器是可以换的（SlackSignInBrowser）：测试用假的，不启动 Chrome。
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "@pi-lead-child/core";
import { ChannelSignInError } from "../types.js";
import { createGabrielCore, type SlackSessionNetwork } from "./slack-gabriel.js";
import { SLACK_SESSION_COOKIE_PREFIX } from "./slack-session.js";

/** 一个登录窗口：读 cookie、等用户关窗口、关掉它。 */
export interface SlackSignInWindow {
  cookies(): Promise<ReadonlyArray<{ name: string; domain: string; value: string }>>;
  // 用户关掉了窗口（或者浏览器自己退出了）。
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/** 打开登录窗口的浏览器。缺省是这台电脑上的 Chrome。 */
export interface SlackSignInBrowser {
  open(url: string, log: (line: string) => void): Promise<SlackSignInWindow>;
}

export interface SlackSignInOptions {
  browser?: SlackSignInBrowser;
  // 验证 cookie 用的网络（测试注入假的 Slack）。
  network?: SlackSessionNetwork;
  // 最多等多久。缺省 5 分钟。
  timeoutMs?: number;
  // 多久看一次 cookie。缺省 1 秒。
  pollMs?: number;
}

/** 登录页。 */
export const SLACK_SIGN_IN_URL = "https://slack.com/signin";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

/** 打开登录窗口，等用户登录，返回会话 cookie。超时、取消、窗口关掉时抛错（给人看的原因）。 */
export async function signInToSlack(options: SlackSignInOptions, context: { log(line: string): void; signal: AbortSignal }): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = Math.max(options.pollMs ?? 1_000, 10);
  const browser = options.browser ?? chromeBrowser();
  const window = await browser.open(SLACK_SIGN_IN_URL, context.log);
  let closedByUser = false;
  void window.closed.then(() => { closedByUser = true; });
  const deadline = Date.now() + timeoutMs;
  const tried = new Set<string>();
  try {
    while (!context.signal.aborted && !closedByUser && Date.now() < deadline) {
      let cookie: string | null = null;
      try {
        cookie = (await window.cookies()).find((item) => item.name === "d" && /(^|\.)slack\.com$/i.test(item.domain.replace(/^\./, "")))?.value ?? null;
      } catch (error) {
        if (closedByUser) break;
        context.log(`sign-in: could not read the cookies yet: ${errorText(error)}`);
      }
      const value = cookie ? decodeCookie(cookie) : null;
      if (value && value.startsWith(SLACK_SESSION_COOKIE_PREFIX) && !tried.has(value)) {
        tried.add(value);
        if (await signsIn(value, options.network, context.log)) {
          context.log("sign-in: signed in to Slack");
          return value;
        }
      }
      await sleep(pollMs, context.signal);
    }
  } finally {
    await window.close().catch((error: unknown) => context.log(`sign-in: closing the window failed: ${errorText(error)}`));
  }
  if (context.signal.aborted) throw new ChannelSignInError("cancelled", "登录取消了。");
  if (closedByUser) throw new ChannelSignInError("window_closed", "登录窗口关掉了，还没有登录成功。");
  throw new ChannelSignInError("timed_out", `等了 ${Math.round(timeoutMs / 60_000)} 分钟还没有登录成功，窗口已经关掉。可以再试一次。`);
}

// Chrome 里的 cookie 值是 URL 编码的；gabriel 两种写法都认，这里统一成解码后的。
function decodeCookie(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function signsIn(cookie: string, network: SlackSessionNetwork | undefined, log: (line: string) => void): Promise<boolean> {
  const core = await createGabrielCore({ cookie, network: network ?? {}, log: (line) => log(`sign-in: ${line}`) });
  try {
    await core.initialize();
    return true;
  } catch {
    return false;
  } finally {
    core.disconnect();
  }
}

// ── Chrome ────────────────────────────────────────────────────────────────────────

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** 这台电脑上的 Chrome：独立的临时配置目录，调试端口只听本机。 */
export function chromeBrowser(input: { path?: string } = {}): SlackSignInBrowser {
  return {
    async open(url, log) {
      const path = input.path ?? CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
      if (!path || !existsSync(path)) throw new ChannelSignInError("no_browser", "这台电脑上没有找到 Google Chrome：装好 Chrome 以后再试。");
      const profile = mkdtempSync(join(tmpdir(), "plc-slack-sign-in-"));
      const child = spawn(path, [
        `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
        "--no-first-run", "--no-default-browser-check", `--app=${url}`,
      ], { stdio: "ignore" });
      const closed = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      });
      // Chrome 的临时配置目录有上千个文件：在子进程里删（core 的 removeTree），不占 daemon 的线程池（lead-scheduler spec P0）。
      const cleanup = () => {
        removeTree(profile, { kind: "browser-profile-delete", label: "slack sign-in profile" }).catch((error: unknown) => {
          log(`sign-in: could not remove the temporary profile: ${errorText(error)}`);
        });
      };
      void closed.then(cleanup);
      let socket: CdpSocket | null = null;
      const connect = async (): Promise<CdpSocket> => {
        if (socket?.open()) return socket;
        const file = join(profile, "DevToolsActivePort");
        if (!existsSync(file)) throw new Error("Chrome is still starting");
        const [port, browserPath] = readFileSync(file, "utf8").split("\n");
        if (!port || !/^\d{1,5}$/.test(port.trim()) || !browserPath?.startsWith("/devtools/browser/")) throw new Error("Chrome is still starting");
        socket = await openCdp(`ws://127.0.0.1:${port.trim()}${browserPath.trim()}`);
        return socket;
      };
      return {
        closed,
        async cookies() {
          const result = await (await connect()).call("Storage.getCookies");
          const cookies = Array.isArray(result.cookies) ? result.cookies as Array<Record<string, unknown>> : [];
          return cookies.flatMap((cookie) => (typeof cookie.name === "string" && typeof cookie.domain === "string" && typeof cookie.value === "string"
            ? [{ name: cookie.name, domain: cookie.domain, value: cookie.value }] : []));
        },
        async close() {
          socket?.close();
          if (child.exitCode === null && !child.killed) child.kill();
          await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())]);
          cleanup();
        },
      };
    },
  };
}

interface CdpSocket {
  open(): boolean;
  call(method: string): Promise<Record<string, unknown>>;
  close(): void;
}

// Chrome 调试接口（CDP）的一条连接：只发不带参数的命令，等对应 id 的回答。
async function openCdp(url: string): Promise<CdpSocket> {
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 5_000 });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  let next = 1;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  ws.on("message", (data) => {
    let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      message = JSON.parse(String(data)) as typeof message;
    } catch {
      return;
    }
    const waiting = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (!waiting) return;
    pending.delete(message.id!);
    if (message.error) waiting.reject(new Error(message.error.message ?? "CDP error"));
    else waiting.resolve(message.result ?? {});
  });
  ws.on("close", () => {
    for (const waiting of pending.values()) waiting.reject(new Error("the Chrome debugging connection closed"));
    pending.clear();
  });
  return {
    open: () => ws.readyState === WebSocket.OPEN,
    call(method) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, 10_000);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        ws.send(JSON.stringify({ id, method }));
      });
    },
    close: () => ws.close(),
  };
}
