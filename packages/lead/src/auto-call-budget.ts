// 自动调用的预算（2026-11-16）。系统自己发起的模型调用（事件叫醒的一轮、空闲车道的活）以前没有上限：
// 2026-11-05 一张工单的预算提示叫醒了 Lead 6,923 轮；2026-11-14 起模型不可用的两天里自动调了 7,028 次。
// 熔断（model-hold.ts）管「一直失败」；这里管「每一次都成功，可是停不下来」：数量超过预算就暂停，告诉用户。
// 用户本人的消息不算、也不受限制。
//
// 缺省值按 2026-11-10 到 11-13 四天正常日子的实测定：系统发起的调用每小时中位数 14 次、最多 88 次，每天 211–523 次；
// 没命中缓存的输入每天 320 万–3,160 万 token。
//   · 每小时 120 次：比正常的最高值多三分之一；
//   · 每天 1,500 次：约是最忙一天的 3 倍；
//   · 每天没命中缓存的输入 5,000 万 token：比最忙一天多一半。
// config.json 的 lead.autoBudget 存这三个上限（callsPerHour、callsPerDay、uncachedTokensPerDay；0 是不限）。
// 设置页「Lead」和 Lead（在用户本人的一轮里）经操作层的 auto_budget.set 改它（工单 #553）：写回 config.json，再调 setLimits，不用重启。
// 记录只在 daemon 的内存里：重启以后从零开始数。风暴要几个小时才成形，重启不会让它躲过去。

export interface AutoCallBudgetLimits {
  callsPerHour: number;
  callsPerDay: number;
  uncachedTokensPerDay: number;
}

export const DEFAULT_AUTO_CALL_BUDGET: AutoCallBudgetLimits = { callsPerHour: 120, callsPerDay: 1_500, uncachedTokensPerDay: 50_000_000 };

export interface AutoCallBudgetExceeded {
  /** 超了哪一条。 */
  limit: keyof AutoCallBudgetLimits;
  /** 暂停到什么时候：到那时这个时间窗里的用量降到上限的八成以下。 */
  until: number;
  /** 一句话（写进日志和给用户的说明）。 */
  detail: string;
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
// 暂停到用量降到上限的这个比例：不然窗口里最老的一次调用一出去，下一次调用马上又超。
const RESUME_RATIO = 0.8;

/** config.json 的 lead.autoBudget：只取写对的数字（非负整数），别的用缺省。 */
/** The input of one model call that the provider did not serve from its cache: pi's usage.input plus usage.cacheWrite. */
export function uncachedTokens(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const used = (key: string) => {
    const value = (usage as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  };
  return used("input") + used("cacheWrite");
}

export function autoCallBudgetLimits(configured: unknown): AutoCallBudgetLimits {
  const limits = { ...DEFAULT_AUTO_CALL_BUDGET };
  if (!configured || typeof configured !== "object") return limits;
  for (const key of Object.keys(limits) as Array<keyof AutoCallBudgetLimits>) {
    const value = (configured as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) limits[key] = value;
  }
  return limits;
}

/** 存下来的调用：每一条是 [时间（毫秒）, 没命中缓存的输入]。 */
export type AutoCallBudgetSnapshot = Array<[number, number]>;

// 存下来的调用里还在 24 小时窗口里的。时间比现在晚一分钟以上的不要（时钟被改过）。
function savedCalls(saved: unknown, now: number): Array<{ at: number; uncached: number }> {
  if (!Array.isArray(saved)) return [];
  const calls: Array<{ at: number; uncached: number }> = [];
  for (const entry of saved) {
    if (!Array.isArray(entry)) continue;
    const [at, uncached] = entry as unknown[];
    if (typeof at !== "number" || typeof uncached !== "number" || !Number.isFinite(at) || !Number.isFinite(uncached)) continue;
    if (at <= now - DAY || at > now + 60_000) continue;
    calls.push({ at, uncached: Math.max(0, uncached) });
  }
  return calls.sort((a, b) => a.at - b.at);
}

export class AutoCallBudget {
  #limits: AutoCallBudgetLimits;
  readonly #now: () => number;
  // 最近 24 小时里的自动调用，按时间排。
  #calls: Array<{ at: number; uncached: number }> = [];

  readonly #onRecord: ((calls: AutoCallBudgetSnapshot) => void) | undefined;

  /**
   * saved：上一个 daemon 进程记下的调用（snapshot 的结果，daemon 存在库里）。重启以后接着算：不然每次重启预算都从零开始。
   * 读到的不是这个形状时当作没有。onRecord：每记一次调用就给出现在的快照，daemon 把它存下来。
   */
  constructor(options: { limits?: AutoCallBudgetLimits; now?: () => number; saved?: unknown; onRecord?: (calls: AutoCallBudgetSnapshot) => void } = {}) {
    this.#limits = options.limits ?? DEFAULT_AUTO_CALL_BUDGET;
    this.#now = options.now ?? Date.now;
    this.#onRecord = options.onRecord;
    this.#calls = savedCalls(options.saved, this.#now());
  }

  /** 最近 24 小时里的自动调用：[时间, 没命中缓存的输入]，按时间排。 */
  snapshot(): AutoCallBudgetSnapshot {
    const now = this.#now();
    this.#calls = this.#calls.filter((call) => call.at > now - DAY);
    return this.#calls.map((call) => [call.at, call.uncached]);
  }

  /** 记一次自动的模型调用（成功、失败都算）。uncachedTokens：没命中缓存的输入（input + cacheWrite）。超了预算时返回超的那一条。 */
  record(uncachedTokens: number): AutoCallBudgetExceeded | null {
    const now = this.#now();
    this.#calls.push({ at: now, uncached: Math.max(0, uncachedTokens) });
    const over = this.exceeded();
    this.#onRecord?.(this.snapshot());
    return over;
  }

  /** 用户定的上限（0 是不限）。 */
  get limits(): AutoCallBudgetLimits {
    return { ...this.#limits };
  }

  /** 换上新的上限（设置页改了以后，工单 #553）。记过的调用不动：下一次 record、exceeded 按新上限算。 */
  setLimits(limits: AutoCallBudgetLimits): void {
    this.#limits = { ...limits };
  }

  usage(): { callsLastHour: number; callsLastDay: number; uncachedTokensLastDay: number } {
    const now = this.#now();
    this.#calls = this.#calls.filter((call) => call.at > now - DAY);
    return {
      callsLastHour: this.#calls.filter((call) => call.at > now - HOUR).length,
      callsLastDay: this.#calls.length,
      uncachedTokensLastDay: this.#calls.reduce((total, call) => total + call.uncached, 0),
    };
  }

  exceeded(): AutoCallBudgetExceeded | null {
    const used = this.usage();
    const { callsPerHour, callsPerDay, uncachedTokensPerDay } = this.#limits;
    if (callsPerHour > 0 && used.callsLastHour >= callsPerHour) {
      const inHour = this.#calls.filter((call) => call.at > this.#now() - HOUR);
      return {
        limit: "callsPerHour", until: this.#untilCount(inHour, callsPerHour, HOUR),
        detail: `${used.callsLastHour} automatic model calls in the last hour (limit ${callsPerHour})`,
      };
    }
    if (callsPerDay > 0 && used.callsLastDay >= callsPerDay) {
      return {
        limit: "callsPerDay", until: this.#untilCount(this.#calls, callsPerDay, DAY),
        detail: `${used.callsLastDay} automatic model calls in the last 24 hours (limit ${callsPerDay})`,
      };
    }
    if (uncachedTokensPerDay > 0 && used.uncachedTokensLastDay >= uncachedTokensPerDay) {
      // 从最老的开始去掉，到剩下的降到八成以下：那一次调用离开窗口的时间。
      let left = used.uncachedTokensLastDay;
      let until = this.#now() + DAY;
      for (const call of this.#calls) {
        left -= call.uncached;
        if (left < uncachedTokensPerDay * RESUME_RATIO) {
          until = call.at + DAY;
          break;
        }
      }
      return {
        limit: "uncachedTokensPerDay", until,
        detail: `${used.uncachedTokensLastDay} uncached input tokens in automatic calls in the last 24 hours (limit ${uncachedTokensPerDay})`,
      };
    }
    return null;
  }

  // 窗口里的调用降到上限的八成以下的时间：第 (现在的数量 - 八成) 个最老的调用离开窗口的时候。
  #untilCount(calls: Array<{ at: number }>, limit: number, window: number): number {
    const keep = Math.max(0, Math.floor(limit * RESUME_RATIO) - 1);
    const leaving = calls[Math.max(0, calls.length - keep - 1)]!;
    return leaving.at + window;
  }
}
