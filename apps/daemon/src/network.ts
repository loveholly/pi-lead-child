// 这台机器的网络通不通。2026-10-15 19:11–20:07 和 2026-10-16 09:29：Mac 合盖睡眠，只有几秒的 DarkWake，
// DNS 解析不了。那时叫醒 Lead 只会得到一张"模型连不上"的失败卡片，再试也一样。
//
// 叫醒 Lead（系统回合）之前先探一次网络。不通时：
//   · 不调模型，等网络恢复（onDown）；
//   · 每隔一段时间再探（退避：PLC_NETWORK_RETRY_MS 起，翻倍，最多 2 分钟）；
//   · 探通了就调 onRestored：daemon 马上接着做积压的事。
// 模型调用本身因为断网失败时（DNS 还有缓存，探测是通的），由 markDown 记下，同样等网络恢复。
import { lookup } from "node:dns/promises";

// 通了返回 null；不通返回原因（会被分类成 network，见 protocol 的 lead-failure）。
export type NetworkProbe = () => Promise<string | null>;

// 解析一个外网域名。缺省是 Lead 的模型服务的域名（PLC_NETWORK_PROBE_HOST 可以改）。
export function dnsProbe(host: string, timeoutMs = 3_000): NetworkProbe {
  return async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        lookup(host),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`network unreachable: lookup ${host} timed out`)), timeoutMs);
          timer.unref();
        }),
      ]);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export class NetworkMonitor {
  private down: { since: number; detail: string } | null = null;
  // 模型调用成功过、之后还没有一次确认是断网的失败：信模型，不信探测（发布评审 f796c1c 的 B1：DNS 探测一直不通，
  // 模型经本机代理却是好的，系统的唤醒不能一直被拦着）。
  private trustModel = false;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = false;

  constructor(private readonly options: {
    probe: NetworkProbe;
    onDown: (detail: string) => void;
    onRestored: () => void;
    retryBaseMs?: number;
    retryMaxMs?: number;
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
    this.restored();
  }

  // 模型调用失败，错误看起来是断网（连接被拒、被重置、DNS）。探一次确认：不通就是断网（返回 true）；
  // 通的话是模型服务或它的代理的问题（返回 false），由调用方按"模型服务连不上"处理。
  async confirmOutage(detail: string): Promise<boolean> {
    const probed = await this.probe();
    if (probed === null) return false;
    this.trustModel = false;
    this.markDown(detail);
    return true;
  }

  private async probe(): Promise<string | null> {
    return this.options.probe().catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  }

  private async probeNow(): Promise<boolean> {
    const detail = await this.probe();
    if (detail === null) {
      this.restored();
      return true;
    }
    this.markDown(detail);
    return false;
  }

  // 记下断网（探测不通，或者模型调用因为断网失败），然后按退避再探。
  markDown(detail: string): void {
    if (this.stopped) return;
    if (!this.down) {
      this.down = { since: Date.now(), detail };
      this.options.onDown(detail);
    }
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private restored(): void {
    if (!this.down) return;
    this.down = null;
    this.failures = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.options.onRestored();
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
