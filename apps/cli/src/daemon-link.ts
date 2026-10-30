// plc 和 daemon 的连接：先在 plc.sock 上问 status（拿到网关地址），daemon 没在运行就自动拉起它。
// 拉起失败时报错并给出排查提示。plc 不再在 daemon 不在时直接写账本。
import { join } from "node:path";
import { dataDir } from "@pi-lead-child/core";
import type { DaemonLocalStatus } from "@pi-lead-child/protocol";
import { LocalSocketUnavailableError, plcSockPath, type LocalRequest } from "./local-socket.js";

export class CliError extends Error {}

export async function daemonStatus(request: LocalRequest, dir?: string): Promise<DaemonLocalStatus | null> {
  try {
    return await request<DaemonLocalStatus>(plcSockPath(dir), { type: "status" }, 3_000);
  } catch (error) {
    if (error instanceof LocalSocketUnavailableError) return null;
    throw error;
  }
}

// ops 入口 start --auto 的退出码：supervisor 拒绝自动拉起（用户 plc daemon stop 过，或者维护进行中）。
// 拒绝的原因和该怎么做（运行 plc daemon start，或者等升级完成）已经由 ops 入口打印出来。
export const AUTO_START_REFUSED = 3;

export interface EnsureDaemonDeps {
  request: LocalRequest;
  // 自动拉起：运行 ops 入口的 start --auto。返回退出码。
  start: () => Promise<number>;
  notice: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  dir?: string;
}

export function startFailureHint(dir: string = dataDir()): string {
  return [
    "daemon 启动失败。",
    `查看日志：${join(dir, "supervisor.log")} 和 ${join(dir, "logs", "coordinatord.err.log")}`,
    "运行 plc doctor 检查配置和构建产物。",
  ].join("\n");
}

export async function ensureDaemon(deps: EnsureDaemonDeps): Promise<DaemonLocalStatus> {
  const running = await daemonStatus(deps.request, deps.dir);
  if (running) return running;
  deps.notice("daemon 未运行，正在启动...");
  const code = await deps.start();
  if (code === AUTO_START_REFUSED) throw new CliError("plc 没有自动启动 daemon（原因见上一行）。");
  if (code !== 0) throw new CliError(startFailureHint(deps.dir));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (deps.waitMs ?? 20_000);
  for (;;) {
    const status = await daemonStatus(deps.request, deps.dir);
    if (status) return status;
    if (Date.now() >= deadline) throw new CliError(startFailureHint(deps.dir));
    await sleep(250);
  }
}
