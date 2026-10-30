// 网关在哪里监听。
// - 回环地址（127.0.0.1）总是监听：plc 和本机的 companion 都靠它。没配置端口时用缺省端口；
//   缺省端口被别的程序占用时退回随机端口，plc 从 plc.sock 的 status 拿到实际地址。
//   配置过的端口不退回：companion 记着那个地址。
// - 网关开到回环之外是一个显式的选择：PLC_GATEWAY_HOST 是局域网、Tailscale 或通配地址时，必须同时
//   配置 PLC_GATEWAY_PORT。只配了 host 时只监听回环，并且警告。
// - 具体的对外地址（局域网、Tailscale）另开一个监听，和回环共用端口。开机时这个地址可能还没就绪
//   （launchd 登录后 Tailscale 或 Wi-Fi 才连上），所以绑不上时在后台退避重试，直到成功（ExposureListener）。
//   已经绑上的地址后来消失（网卡断开、Tailscale 退出）时，监听保持原样；地址回来后通常照常可用。
//   地址换了（例如拿到新的局域网 IP）需要重启 daemon。
// - 通配地址（0.0.0.0、::）本身就包含回环，只开这一个监听：Linux 上它不能和 127.0.0.1 共用端口。
//   通配地址绑不上时只监听回环，并且警告。
import type { GatewayExposureStatus } from "@pi-lead-child/protocol";

export const DEFAULT_GATEWAY_PORT = 47130;

export interface GatewayListenPlan {
  port: number;
  // 端口被占用时，是否改用随机端口。
  portFallback: boolean;
  // 主监听的地址：127.0.0.1，或者配置的通配地址（它包含回环）。
  primaryHost: string;
  // 另开监听的具体对外地址。null：没有。
  exposeHost: string | null;
  // 启动时要大声说出来的配置问题。
  warnings: string[];
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

export function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

export function resolveGatewayListen(
  explicitPort: number | undefined,
  env: Record<string, string | undefined>,
): GatewayListenPlan {
  const configuredHost = env.PLC_GATEWAY_HOST?.trim() || "127.0.0.1";
  const raw = env.PLC_GATEWAY_PORT?.trim();
  let port: number | undefined = explicitPort;
  if (port === undefined && raw) {
    port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(port) || port > 65_535) {
      throw new Error(`PLC_GATEWAY_PORT must be a port number between 0 and 65535, got '${raw}'`);
    }
  }
  const exposed = !isLoopbackHost(configuredHost);
  if (port !== undefined) {
    const wildcard = isWildcardHost(configuredHost);
    return {
      port, portFallback: false,
      primaryHost: wildcard ? configuredHost : "127.0.0.1",
      exposeHost: exposed && !wildcard ? configuredHost : null,
      warnings: [],
    };
  }
  return {
    port: DEFAULT_GATEWAY_PORT, portFallback: true, primaryHost: "127.0.0.1", exposeHost: null,
    warnings: exposed
      ? [`PLC_GATEWAY_HOST=${configuredHost} is ignored: exposing the gateway beyond loopback needs an explicit `
        + "PLC_GATEWAY_PORT as well. Listening on loopback only."]
      : [],
  };
}

// 主监听。通配地址绑不上时退回回环；缺省端口被占用时退回随机端口。返回实际用的地址。
export async function listenWithFallback<T>(
  listen: (port: number, host: string) => Promise<T>,
  plan: GatewayListenPlan,
  log: (line: string) => void,
): Promise<{ value: T; host: string }> {
  for (const warning of plan.warnings) log(`[gateway] WARNING: ${warning}`);
  let host = plan.primaryHost;
  try {
    return { value: await listen(plan.port, host), host };
  } catch (error) {
    let failure = error;
    if (isWildcardHost(host)) {
      log(`[gateway] WARNING: cannot listen on ${host}:${plan.port} (${(error as Error).message}); `
        + "listening on loopback only. Check PLC_GATEWAY_HOST and PLC_GATEWAY_PORT.");
      host = "127.0.0.1";
      try {
        return { value: await listen(plan.port, host), host };
      } catch (loopbackError) {
        failure = loopbackError;
      }
    }
    if (!plan.portFallback || (failure as { code?: unknown }).code !== "EADDRINUSE") throw failure;
    log(`[gateway] port ${plan.port} is in use; listening on a random port instead`);
    return { value: await listen(0, host), host };
  }
}

// 通配地址的状态：它就是主监听，不重试。绑上了是 listening；退回回环时是 stopped，并带上原因。
export function wildcardExposure(host: string, port: number, bound: boolean, error: string | null): {
  status(): GatewayExposureStatus;
  stop(): Promise<void>;
} {
  let state: GatewayExposureStatus["state"] = bound ? "listening" : "stopped";
  return {
    status: () => ({ host, port, state, attempts: 1, lastError: bound ? null : error, nextRetryAt: null }),
    stop: async () => { state = "stopped"; },
  };
}

// 回环之外的那个监听。绑不上时退避重试（baseDelayMs 起，每次翻倍，最多 maxDelayMs），直到成功或 stop。
export class ExposureListener {
  private state: GatewayExposureStatus["state"] = "retrying";
  private attempts = 0;
  private lastError: string | null = null;
  private nextRetryAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listener: { close(): Promise<void> } | null = null;
  private stopped = false;

  constructor(private readonly options: {
    host: string;
    port: number;
    listen: (host: string, port: number) => Promise<{ close(): Promise<void> }>;
    log: (line: string) => void;
    baseDelayMs?: number;
    maxDelayMs?: number;
  }) {}

  async start(): Promise<void> {
    await this.attempt();
  }

  status(): GatewayExposureStatus {
    return {
      host: this.options.host,
      port: this.options.port,
      state: this.state,
      attempts: this.attempts,
      lastError: this.lastError,
      nextRetryAt: this.nextRetryAt === null ? null : new Date(this.nextRetryAt).toISOString(),
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRetryAt = null;
    this.state = "stopped";
    await this.listener?.close();
    this.listener = null;
  }

  private async attempt(): Promise<void> {
    if (this.stopped) return;
    this.attempts += 1;
    const { host, port } = this.options;
    try {
      this.listener = await this.options.listen(host, port);
      if (this.stopped) { await this.listener.close(); return; }
      this.state = "listening";
      this.lastError = null;
      this.nextRetryAt = null;
      this.options.log(`[gateway] now listening on ${host}:${port}${this.attempts > 1 ? ` (after ${this.attempts} attempts)` : ""}`);
    } catch (error) {
      const base = this.options.baseDelayMs ?? 1_000;
      const delay = Math.min(base * 2 ** (this.attempts - 1), this.options.maxDelayMs ?? 60_000);
      this.state = "retrying";
      this.lastError = (error as Error).message;
      this.nextRetryAt = Date.now() + delay;
      this.options.log(`[gateway] WARNING: cannot listen on ${host}:${port} (${this.lastError}); `
        + `retrying in ${Math.round(delay / 1000)}s. Loopback keeps working. Check PLC_GATEWAY_HOST.`);
      this.timer = setTimeout(() => { this.timer = null; void this.attempt(); }, delay);
      this.timer.unref?.();
    }
  }
}
