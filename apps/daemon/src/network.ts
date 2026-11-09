// 这台机器的网络通不通。2026-10-15 19:11–20:07 和 2026-10-16 09:29：Mac 合盖睡眠，只有几秒的 DarkWake，
// DNS 解析不了。那时叫醒 Lead 只会得到一张"模型连不上"的失败卡片，再试也一样。
//
// 叫醒 Lead（系统回合）之前先探一次网络。不通时：
//   · 不调模型，等网络恢复（onDown）；
//   · 每隔一段时间再探（退避：PLC_NETWORK_RETRY_MS 起，翻倍，最多 2 分钟）；
//   · 探通了就调 onRestored：daemon 马上接着做积压的事。
// 模型调用本身因为断网失败时（DNS 还有缓存，探测是通的），由 markDown 记下，同样等网络恢复。
//
// 2026-11-06：DNS 通了，到模型服务的路不一定通。短暂唤醒时流量没有走 VPN，Anthropic 按来源地区回
// 403 "Request not allowed"。模型回了这一种错误时，用不带 key 的探测（routeProbe）确认，路通了才接着调模型。
import { lookup, Resolver } from "node:dns/promises";
import { schedLine } from "@pi-lead-child/core";
import { isLeadRouteBlock } from "@pi-lead-child/protocol";

// 通了返回 null；不通返回原因（会被分类成 network，见 protocol 的 lead-failure）。
export type NetworkProbe = () => Promise<string | null>;

export interface DnsProbeDeps {
  // 系统解析（getaddrinfo）。它在 Node 的 I/O 线程池里跑。
  lookup?: (host: string) => Promise<unknown>;
  // c-ares 解析。它不经过线程池。
  resolve?: (host: string) => Promise<unknown>;
  log?: (line: string) => void;
}

const TIMED_OUT = Symbol("timed out");

async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveWithCares(host: string, timeoutMs: number): Promise<unknown> {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  return Promise.any([resolver.resolve4(host), resolver.resolve6(host)]);
}

// 解析一个外网域名。缺省是 Lead 的模型服务的域名（PLC_NETWORK_PROBE_HOST 可以改）。
// 系统解析超时的时候，再用 c-ares 问一次（lead-scheduler spec P0）：getaddrinfo 在 I/O 线程池里跑，线程池被进程里的
// 重活占满时（2026-11-09，后台删 worktree），它一直排不上，网络其实是通的。c-ares 不经过线程池：它解析得到就算网通。
// 两个都答不上来才算断网。系统解析明确失败（例如 ENOTFOUND）时照旧算断网，不再问。
export function dnsProbe(host: string, timeoutMs = 3_000, deps: DnsProbeDeps = {}): NetworkProbe {
  const lookupHost = deps.lookup ?? ((name: string) => lookup(name));
  const resolveHost = deps.resolve ?? ((name: string) => resolveWithCares(name, timeoutMs));
  return async () => {
    const timedOut = `network unreachable: lookup ${host} timed out`;
    try {
      if (await within(lookupHost(host), timeoutMs) !== TIMED_OUT) return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    const started = Date.now();
    try {
      if (await within(resolveHost(host), timeoutMs) === TIMED_OUT) return timedOut;
    } catch {
      return timedOut;
    }
    deps.log?.(schedLine("network.dns_lookup_slow", {
      host, timeoutMs, resolvedBy: "c-ares", caresMs: Date.now() - started, note: "getaddrinfo is stuck, the network is up",
    }));
    return null;
  };
}

// 不带 key 向模型服务发一个请求。请求里没有 key，不用任何账号，也不经过本机的模型代理（代理不会因此冷却账号）。
// 路通时服务回 401（缺 key）；来源被拦时回 403。其他回答也算路通：探测只认 403。
export function keylessProbe(host: string, timeoutMs = 5_000): NetworkProbe {
  return async () => {
    try {
      const response = await fetch(`https://${host}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel().catch(() => {});
      // 原因里不写状态码：带着 403 的原因会被分类成认证失败（protocol 的 lead-failure）。
      return response.status === 403 ? `network unreachable: ${host} refuses requests from this network` : null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
}

// 路被拦着时最多等多久，然后放一次模型调用过去（见 probeNow）。
const ROUTE_MAX_WAIT_MS = 30 * 60_000;

export class NetworkMonitor {
  // route：模型回过 403 "Request not allowed"，要等不带 key 的探测通过。
  private down: { since: number; detail: string; route: boolean } | null = null;
  // 模型调用成功过、之后还没有一次确认是断网的失败：信模型，不信探测（发布评审 f796c1c 的 B1：DNS 探测一直不通，
  // 模型经本机代理却是好的，系统的唤醒不能一直被拦着）。
  private trustModel = false;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = false;

  constructor(private readonly options: {
    probe: NetworkProbe;
    // 不带 key 的探测（keylessProbe）。没有时，路被拦了也用 probe 确认。
    routeProbe?: NetworkProbe;
    onDown: (detail: string) => void;
    // probe：探测通过；model：模型调用成功；waited：路被拦着，等满了 routeMaxWaitMs。
    onRestored: (how: "probe" | "model" | "waited") => void;
    retryBaseMs?: number;
    retryMaxMs?: number;
    routeMaxWaitMs?: number;
  }) {}

  // 最近一次知道的状态。断网以后在探通之前一直是 false。
  get online(): boolean {
    return this.down === null;
  }

  // 断网从什么时候开始。没断时是 null。
  get downSince(): number | null {
    return this.down?.since ?? null;
  }

  // 叫醒 Lead 之前问一次：通吗。模型刚证明过自己是好的就不探。
  async check(): Promise<boolean> {
    if (this.trustModel) return true;
    return this.probeNow();
  }

  // 模型调用成功：网络（至少到模型服务的路）是通的。断网的状态结束，onRestored 照常调。
  modelSucceeded(): void {
    this.trustModel = true;
    this.restored("model");
  }

  // 模型调用失败，错误看起来是断网（连接被拒、被重置、DNS）。探一次确认：不通就是断网（返回 true）；
  // 通的话是模型服务或它的代理的问题（返回 false），由调用方按"模型服务连不上"处理。
  // 模型回了 403 "Request not allowed"（路被拦了）：DNS 看不出这一种，用不带 key 的探测确认。
  async confirmOutage(detail: string): Promise<boolean> {
    const route = this.options.routeProbe !== undefined && isLeadRouteBlock(detail);
    const probed = await this.probe(route);
    if (probed === null) return false;
    this.trustModel = false;
    this.markDown(detail, route);
    return true;
  }

  private async probe(route = false): Promise<string | null> {
    const probe = route && this.options.routeProbe ? this.options.routeProbe : this.options.probe;
    return probe().catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  }

  private async probeNow(): Promise<boolean> {
    const route = this.down?.route ?? false;
    const detail = await this.probe(route);
    if (detail === null) {
      this.restored("probe");
      return true;
    }
    // 路被拦着，已经等满了 routeMaxWaitMs：放一次模型调用过去。本机的模型代理可能走另一条路（配了自己的上游代理），
    // daemon 的探测一直被拦，代理那边已经好了。那一次又被拦时，confirmOutage 重新开始等。
    if (route && this.down && Date.now() - this.down.since >= (this.options.routeMaxWaitMs ?? ROUTE_MAX_WAIT_MS)) {
      this.restored("waited");
      return true;
    }
    this.markDown(detail);
    return false;
  }

  // 记下断网（探测不通，或者模型调用因为断网失败），然后按退避再探。
  markDown(detail: string, route = false): void {
    if (this.stopped) return;
    if (!this.down) {
      this.down = { since: Date.now(), detail, route };
      this.options.onDown(detail);
    }
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private restored(how: "probe" | "model" | "waited"): void {
    if (!this.down) return;
    this.down = null;
    this.failures = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.options.onRestored(how);
  }

  private schedule(): void {
    if (this.timer || this.stopped) return;
    const base = this.options.retryBaseMs ?? 15_000;
    const delay = Math.min(base * 2 ** this.failures, this.options.retryMaxMs ?? 120_000);
    this.failures += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check();
    }, delay);
    this.timer.unref();
  }
}
