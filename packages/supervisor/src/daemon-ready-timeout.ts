// supervisor 等新 daemon 回答第一次 status 的期限，和 plc daemon start 等 ensure_running 回答的期限，读同一个环境变量。
// 以前 plc 固定等 35 秒，supervisor 等 120 秒：负载高时 daemon 3 分钟才就绪，plc 先放弃，报了启动失败（2026-11-02）。

// 负载高时 daemon 启动会超过 30 秒：2026-10-19 14:54Z 负载约 37，daemon 用了 39 秒才开始监听。
// 进程还活着就接着等，所以这个期限只用来认定启动卡住了，可以比正常启动时间长得多。
export const DEFAULT_DAEMON_READY_TIMEOUT_MS = 120_000;

// supervisor 等 daemon 之前还要查部署闸门、探测 socket，等到以后还要回答 plc：plc 比它多等这么久。
export const ENSURE_RUNNING_MARGIN_MS = 15_000;

// PLC_DAEMON_READY_TIMEOUT_MS：daemon 启动以后最多等多久它回答 status（毫秒）。不是正整数时用缺省值。
export function daemonReadyTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const configured = Number(env.PLC_DAEMON_READY_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_DAEMON_READY_TIMEOUT_MS;
}

// plc daemon start 最多等 ensure_running 多久。
export function ensureRunningTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return daemonReadyTimeoutMs(env) + ENSURE_RUNNING_MARGIN_MS;
}
