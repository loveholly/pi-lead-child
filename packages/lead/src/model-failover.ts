// Lead 的模型切换（spec D9）。以前 Lead 只用 lead.models[0]（model-config.ts 的 selectedLeadModelSpec）：
// 2026-10-16 16:57 的心跳巡检遇到 429（21 秒里试了 4 次，140 秒后才恢复），Lead 只能等，配好的第二个模型一直没用上。
// 2026-10-19 09:06–09:41，Lead 连续失败 35 分钟：先是 DNS（Mac 刚醒），后是 503 auth_unavailable。
// 那时只有限流和上下文溢出才换模型，lead.models 的另外两个一直没用上。现在 daemon 在 Lead 的一轮失败以后问这里：
//   · 网络断了（daemon 探测确认过）：不换。daemon 不调这里，等网络恢复（server.ts 的 network.confirmOutage）；
//     这里也不把网络类的错误当成换模型的理由；
//   · 限流、额度用尽、授权失败、模型不存在：按 lead.models 的顺序换下一个模型；
//   · 模型服务不可用（5xx、超时、连接断开）、上下文溢出：连续两轮才换。一次网络抖动不换模型，也不让用户收到两条切换的说明
//     （2026-10-19 审查）；pi 遇到溢出自己会先压缩再试一次；
//   · 换走以后什么时候用回第一个模型：服务端给了恢复时间时按它（最优先）；额度用尽、服务端没给时间、错误又明确说是周额度时，
//     按这类模型的周重置时间（DEFAULT_LEAD_QUOTA_RESETS：笔记 #46，Claude 的额度每周一 16:00 重置，
//     config.json 的 lead.quotaResets 可以改）；都没有时等 restoreAfterMs（缺省 30 分钟）再试第一个模型；
//   · 额度用尽的模型在可以再用以前跳过，不再去试（重启 daemon 也记得：quotaStore 存在 kv 里）；
//     判断错了可以手动清掉（clearBlocked，Lead 的 clear_lead_model_quota 工具）；
//   · 所有模型都失败了：不再换，daemon 现有的停摆流程接手。
// 这里只做决定，不碰会话和配置：daemon 在下一轮开始前用 pi 的 setModel 换模型（session.ts 的 switchModel），
// 并告诉用户（server.ts 的 syncLeadModel 写一条要告诉用户的 lead.model_switched）。
// 自动切换不改 config.json：switch_lead_model 改的是用户排好的顺序，还要重启 daemon；限流是一时的，
// 改了顺序就回不到用户的第一个模型了。
import { classifyLeadModelError } from "@pi-lead-child/protocol";
import { localIso } from "@pi-lead-child/core";

export type LeadModelFailureCause = "rate_limit" | "context_overflow" | "quota" | "auth" | "unavailable" | "model";

// 额度按周重置的一类模型（2026-10-19）：模型名（provider/model）里含 match 的，额度用尽后到下一个 weekday（0 是周日）
// 的 time（本机时区 HH:MM）之前都跳过。所有模型可能走同一个代理 provider，所以按模型名认，不按 provider。
export interface LeadModelQuotaReset {
  match: string;
  weekday: number;
  time: string;
}

// 笔记 #46：Claude 的额度每周一 16:00 重置。按模型名认（claude-sonnet-5-5 这样的模型 id），
// 不是 Claude Code 这个 runtime（内核不按 runtime 的名字分支，apps/daemon/test/runtime-architecture.test.ts）。
export const DEFAULT_LEAD_QUOTA_RESETS: readonly LeadModelQuotaReset[] = [{ match: "claude-", weekday: 1, time: "16:00" }];

// 没有恢复时间可依据时，换走多久以后再试第一个模型。
export const DEFAULT_LEAD_MODEL_RESTORE_MS = 30 * 60_000;

/** 额度用尽、在重置以前跳过的模型：模型名 → 到什么时候（毫秒时间戳）。daemon 存在 kv 里，重启不丢。 */
export interface LeadModelQuotaStore {
  load(): Record<string, number>;
  save(blocked: Record<string, number>): void;
}

export type LeadModelFailoverDecision =
  | { kind: "none" }
  | {
    kind: "switch";
    from: string;
    to: string;
    cause: LeadModelFailureCause | "recovered";
    // 一句话说明为什么换，写进日志和 Lead 下一轮的输入。
    reason: string;
    // 服务端给的恢复时间（毫秒时间戳）：到时用回第一个模型。没有给时为 null。
    restoreAt: number | null;
  }
  | { kind: "exhausted"; cause: LeadModelFailureCause; reason: string; tried: string[] };

export interface LeadModelFailover {
  readonly models: readonly string[];
  // 启动时就不用第一个模型的原因（它的额度还没重置）。daemon 在第一轮开始前换模型时用它说明为什么。没有时是 null。
  readonly startup: { reason: string; restoreAt: number } | null;
  // 现在应该用哪个模型。daemon 每一轮开始前和正在用的比，不一样就换。
  desired(): string;
  // Lead 的一轮以这个错误失败。
  turnFailed(rawError: string, now?: number): LeadModelFailoverDecision;
  // Lead 的一轮成功了：这次故障结束，失败过的模型又可以用了，溢出不再连续。
  turnSucceeded(): void;
  // 会话换不到这个模型（例如没有配置认证）：跳过它，换下一个。
  unusable(spec: string, error: string): LeadModelFailoverDecision;
  // 服务端给的恢复时间到了：用回第一个模型。没到或者已经在用第一个时返回 null。
  restore(now?: number): LeadModelFailoverDecision | null;
  // 换不到任何别的模型，daemon 留在这个模型上：之后从它算起，不再每一轮都去试那些换不到的模型。
  stayOn(spec: string): void;
  // 额度用尽、还在跳过的模型和可以再用的时间（毫秒时间戳）。
  blockedModels(now?: number): Array<{ model: string; until: number }>;
  // 手动清掉额度的封禁（判断错了，或者用户说额度已经恢复）：给了模型只清它，不给清全部。返回清掉了哪些。
  clearBlocked(spec?: string): string[];
}

// 各家 provider 上下文溢出的说法（照 pi-ai 的 utils/overflow.ts 摘了常见的几种；lead 包不直接依赖 pi-ai）。
const OVERFLOW = [
  /prompt (?:is )?too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /maximum context length/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /model_context_window_exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /context overflow/i,
];
// 限流的说法里也可能有 too many tokens（Bedrock），那不是溢出。
const NOT_OVERFLOW = [/rate.?limit/i, /too many requests/i, /throttl/i];

export function isLeadContextOverflow(raw: string): boolean {
  return !NOT_OVERFLOW.some((pattern) => pattern.test(raw)) && OVERFLOW.some((pattern) => pattern.test(raw));
}

// 额度用尽的说法（和 runtime 的 typed-failure.ts 认的 out_of_credits、insufficient_quota 同一类）。
const QUOTA = /insufficient[_ ]quota|exceeded your current quota|quota (?:exceeded|exhausted)|usage limit|weekly limit|out of credits|credit balance is too low|billing/i;
// 明确说是按周的额度（provider 的错误原文）。只有这时才按周重置的规则封到下一次重置。
const WEEKLY = /\bweekly\b|\bper week\b|\bthis week\b|\b7[- ]day\b|\bseven[- ]day\b/i;

export function isLeadQuotaExhausted(raw: string): boolean {
  return QUOTA.test(raw);
}

export function isLeadWeeklyQuota(raw: string): boolean {
  return WEEKLY.test(raw);
}

/**
 * 这次失败要不要换模型，按什么原因（决策边界，纯函数）。网络类（network）和认不出的（unknown）不换：
 * 网络断了换哪个模型都一样，等网络恢复；认不出的先按原来的退避再试。
 */
export function leadModelFailureCause(raw: string): LeadModelFailureCause | null {
  if (isLeadQuotaExhausted(raw)) return "quota";
  const kind = classifyLeadModelError(raw);
  if (kind === "busy") return "rate_limit";
  if (isLeadContextOverflow(raw)) return "context_overflow";
  if (kind === "auth") return "auth";
  if (kind === "config") return "model";
  if (kind === "unavailable") return "unavailable";
  return null;
}

/** 下一次 weekday 的 time（本机时区）。正好是现在时取下一周的。 */
export function nextWeeklyReset(now: number, reset: Pick<LeadModelQuotaReset, "weekday" | "time">): number | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(reset.time.trim());
  if (!match || !Number.isInteger(reset.weekday) || reset.weekday < 0 || reset.weekday > 6) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const today = new Date(now);
  const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hours, minutes, 0, 0);
  at.setDate(at.getDate() + ((reset.weekday - at.getDay() + 7) % 7));
  if (at.getTime() <= now) at.setDate(at.getDate() + 7);
  return at.getTime();
}

const CAUSE_LABELS: Record<LeadModelFailureCause, string> = {
  rate_limit: "的模型服务限流",
  context_overflow: "连续两轮上下文溢出",
  quota: "的额度用完了",
  auth: "的账号授权失败",
  unavailable: "的模型服务不可用",
  model: "的模型配置有误（模型不存在或不支持）",
};

const UNIT = "(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)";
const RETRY_AFTER: Array<{ pattern: RegExp; unit?: string }> = [
  // pi-ai 在服务端要的等待超过上限时这样报错（utils/provider-retry.ts）。
  { pattern: /server requested (\d+(?:\.\d+)?)s retry delay/i, unit: "s" },
  // OpenAI 的「Please try again in 20s」，Codex 的「Try again in ~5 min」。
  { pattern: new RegExp(`try again in ~?\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT}\\b`, "i") },
  { pattern: /resets?[_ ]in[_ ]seconds["']?\s*[:=]\s*(\d+(?:\.\d+)?)/i, unit: "s" },
  { pattern: new RegExp(`resets? (?:in|after) (\\d+(?:\\.\\d+)?)\\s*${UNIT}\\b`, "i") },
  { pattern: new RegExp(`retry[-_ ]after["']?\\s*[:=]?\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT}?`, "i"), unit: "s" },
];

function unitMs(unit: string): number {
  const value = unit.toLowerCase();
  if (value === "ms" || value.startsWith("milli")) return 1;
  if (value.startsWith("h")) return 3_600_000;
  if (value.startsWith("m")) return 60_000;
  return 1_000;
}

// 服务端在错误里给的恢复时间（毫秒）。没给时返回 null。
export function leadModelRetryAfterMs(raw: string): number | null {
  for (const { pattern, unit } of RETRY_AFTER) {
    const match = pattern.exec(raw);
    if (!match) continue;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount < 0) continue;
    return Math.round(amount * unitMs(match[2] ?? unit ?? "s"));
  }
  return null;
}

function brief(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

export function createLeadModelFailover(options: {
  models: readonly string[];
  quotaResets?: readonly LeadModelQuotaReset[];
  quotaStore?: LeadModelQuotaStore;
  restoreAfterMs?: number;
  now?: () => number;
}): LeadModelFailover {
  const models = [...new Set(options.models.map((model) => model.trim()).filter(Boolean))];
  if (models.length === 0) throw new Error("Lead 至少要有一个模型");
  const quotaResets = options.quotaResets ?? DEFAULT_LEAD_QUOTA_RESETS;
  const restoreAfterMs = options.restoreAfterMs ?? DEFAULT_LEAD_MODEL_RESTORE_MS;
  const clock = options.now ?? Date.now;
  // 额度用尽、在重置以前跳过的模型（模型名 → 到什么时候）。只留这一组模型里的、还没到时间的。
  let blocked: Record<string, number> = {};
  try {
    const stored = options.quotaStore?.load() ?? {};
    const at = clock();
    blocked = Object.fromEntries(Object.entries(stored).filter(([spec, until]) =>
      models.includes(spec) && typeof until === "number" && until > at));
  } catch {
    blocked = {};
  }
  const isBlocked = (index: number, now: number) => (blocked[models[index]!] ?? 0) > now;
  let desired = 0;
  // 这次故障里已经失败过的模型（按下标）。成功一轮以后清空。
  const failed = new Set<number>();
  let overflowStreak = 0;
  // 连续几轮模型服务不可用（5xx、超时、连接断开）。到 2 才换：一次抖动不换模型。
  let unavailableStreak = 0;
  // 下一次换回第一个模型的原因（手动清掉封禁时写明是这样换回的）。没有时用「恢复时间到了」。
  let restoreNote: string | null = null;
  let restoreAt: number | null = null;
  // 最近一次决定换模型的原因：换不到某个模型、接着换下一个时沿用。
  let last: { from: string; cause: LeadModelFailureCause; reason: string } | null = null;

  // 启动时第一个模型的额度还没重置：从第一个没被跳过的模型开始，到重置时间再用回第一个。
  let startup: LeadModelFailover["startup"] = null;
  {
    const at = clock();
    if (isBlocked(0, at)) {
      const usable = models.findIndex((_, index) => !isBlocked(index, at));
      if (usable > 0) {
        desired = usable;
        restoreAt = blocked[models[0]!]!;
        startup = { reason: `${models[0]} 的额度用完了，${localIso(new Date(restoreAt))} 重置以前不用它`, restoreAt };
      }
    }
  }

  const saveBlocked = () => {
    try {
      options.quotaStore?.save({ ...blocked });
    } catch {
      // 存不下只影响重启以后：那时第一轮会再撞一次额度，再换。
    }
  };

  // 额度用尽：跳过到什么时候（2026-10-19 审查：一条「resets in 3 hours」曾经让 Claude 模型被封到下周一）。
  //   1. 服务端给了恢复时间：按它；
  //   2. 没给时间，错误又明确说是周额度，并且这个模型属于一类按周重置的模型（quotaResets）：到下一次周重置；
  //   3. 都不是：等 restoreAfterMs。
  // 属于一类模型时（同一个账号的额度），这一类都跳过；不属于时只跳过这一个。返回这个模型可以再用的时间。
  const blockForQuota = (spec: string, raw: string, now: number): number => {
    const family = quotaResets.find((reset) => reset.match && spec.toLowerCase().includes(reset.match.toLowerCase()));
    const serverWait = leadModelRetryAfterMs(raw);
    const weekly = serverWait === null && family && isLeadWeeklyQuota(raw) ? nextWeeklyReset(now, family) : null;
    const until = serverWait !== null ? now + serverWait : weekly ?? now + restoreAfterMs;
    const members = family ? models.filter((model) => model.toLowerCase().includes(family.match.toLowerCase())) : [spec];
    for (const member of members) blocked[member] = Math.max(blocked[member] ?? 0, until);
    saveBlocked();
    return until;
  };

  // 从现在的模型往后按顺序找（到末尾后从头开始），跳过这次故障里失败过的和额度还没重置的。
  const next = (now: number): number | null => {
    for (let step = 1; step < models.length; step += 1) {
      const index = (desired + step) % models.length;
      if (!failed.has(index) && !isBlocked(index, now)) return index;
    }
    return null;
  };

  const advance = (from: string, cause: LeadModelFailureCause, reason: string, now: number): LeadModelFailoverDecision => {
    last = { from, cause, reason };
    const index = next(now);
    if (index === null) {
      return { kind: "exhausted", cause, reason, tried: models.filter((_, at) => failed.has(at) || isBlocked(at, now)) };
    }
    desired = index;
    // 绕回了第一个模型：不用再等它恢复。
    if (index === 0) restoreAt = null;
    return { kind: "switch", from, to: models[index]!, cause, reason, restoreAt };
  };

  return {
    models,
    startup,
    desired: () => models[desired]!,
    turnFailed(rawError, now = clock()) {
      const cause = leadModelFailureCause(rawError);
      if (cause === null) {
        overflowStreak = 0;
        unavailableStreak = 0;
        return { kind: "none" };
      }
      if (cause === "context_overflow") {
        overflowStreak += 1;
        if (overflowStreak < 2) return { kind: "none" };
      }
      if (cause === "unavailable") {
        unavailableStreak += 1;
        if (unavailableStreak < 2) return { kind: "none" };
      }
      overflowStreak = 0;
      unavailableStreak = 0;
      const from = models[desired]!;
      failed.add(desired);
      const quotaUntil = cause === "quota" ? blockForQuota(from, rawError, now) : null;
      // 第一个模型失败时记下什么时候再试它（每次都重新记，不留上一次的）：服务端给的恢复时间；
      // 额度用尽时是重置时间；都没有时等 restoreAfterMs。
      if (desired === 0) {
        const serverWait = leadModelRetryAfterMs(rawError);
        restoreAt = quotaUntil ?? (serverWait !== null ? now + serverWait : now + restoreAfterMs);
      }
      const reason = cause === "quota" && quotaUntil !== null
        ? `${from}${CAUSE_LABELS[cause]}（${brief(rawError)}），${localIso(new Date(quotaUntil))} 以前不再用它`
        : `${from}${CAUSE_LABELS[cause]}（${brief(rawError)}）`;
      return advance(from, cause, reason, now);
    },
    turnSucceeded() {
      failed.clear();
      overflowStreak = 0;
      unavailableStreak = 0;
    },
    blockedModels(now = clock()) {
      return Object.entries(blocked).filter(([, until]) => until > now).map(([model, until]) => ({ model, until }));
    },
    clearBlocked(spec) {
      const cleared = Object.keys(blocked).filter((model) => spec === undefined || model === spec);
      for (const model of cleared) delete blocked[model];
      if (cleared.length) saveBlocked();
      // 第一个模型的封禁清掉了：下一轮开始前换回它（restore 看 restoreAt）。
      if (desired !== 0 && cleared.length && !isBlocked(0, clock())) {
        restoreAt = clock();
        restoreNote = `${cleared.join("、")} 的额度封禁被手动清掉了，换回第一个模型`;
      }
      return cleared;
    },
    unusable(spec, error) {
      const index = models.indexOf(spec);
      if (index >= 0) failed.add(index);
      const from = last?.from ?? models[0]!;
      const cause = last?.cause ?? "rate_limit";
      return advance(from, cause, `${last?.reason ?? "换模型"}；${spec} 用不了（${brief(error)}）`, clock());
    },
    restore(now = clock()) {
      if (desired === 0 || restoreAt === null || now < restoreAt) return null;
      // 第一个模型的额度还没重置（例如重置时间比恢复时间晚）：等到那时。
      if (isBlocked(0, now)) {
        restoreAt = blocked[models[0]!]!;
        return null;
      }
      const from = models[desired]!;
      desired = 0;
      restoreAt = null;
      failed.clear();
      overflowStreak = 0;
      last = null;
      const reason = restoreNote ?? `${models[0]} 的恢复时间到了，换回第一个模型`;
      restoreNote = null;
      return { kind: "switch", from, to: models[0]!, cause: "recovered", reason, restoreAt: null };
    },
    stayOn(spec) {
      const index = models.indexOf(spec);
      if (index >= 0) desired = index;
    },
  };
}
