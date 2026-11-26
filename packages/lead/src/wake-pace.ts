// When the daemon wakes Lead for ordinary system events (user 2026-11-16; the setting is protocol's wake-pace.ts).
//
// Each wake reads Lead's whole context. Within a few minutes of the last model call the provider still holds it in the
// prompt cache and the read is cheap. After that a wake pays the full input price for the whole context: a cold start.
// The numbers of 2026-11-10..13: about 250 wakes a day for system events, a context of about 150K tokens.
//
// The rule, when the user or Lead set a batch window:
//   - warm cache: wake now. It is cheap, and waiting would let the cache expire.
//   - cold cache: wait until the window ends, counted from the first waiting event, then wake once for everything that
//     arrived. A larger window never makes more cold starts than a smaller one.
//   - something urgent waits: wake now.
// The gather window (user 2026-11-19, protocol's lead-shadow.ts gatherSeconds): ordinary events that arrive close together
// go out as one batch. When the cold rule above does not hold them, they wait until gatherMs after the first waiting
// event. 350 of 635 background turns in the week to 2026-11-19 began within 60 s of the previous turn: each one paid
// a whole wake. The window is short (seconds), so the cache stays warm while it waits.
// What is urgent is the caller's rule (apps/daemon, wakeForEvents): the user's own messages, people who wait in an
// external channel, reminders and the user's own follow-ups never reach this function; an event at level interrupt
// makes the batch urgent.
// This function has no side effects.

export interface WakePaceFacts {
  now: number;
  // The setting in milliseconds. 0: no waiting.
  coldBatchMs: number;
  // When Lead's last model call ended; null when there was none in this process.
  lastModelCallAt: number | null;
  // How long after a model call the provider's cache counts as warm (compaction-chunks.ts, PREFIX_WARM_MS).
  warmMs: number;
  // When the first waiting event arrived; null when its time is not known.
  firstWaitingAt: number | null;
  // Something in the batch must not wait.
  urgent: boolean;
  // The gather window in milliseconds (lead_shadow.gatherSeconds). 0 or missing: no gathering.
  gatherMs?: number;
}

export type WakePaceDecision =
  | { wake: true; why: "off" | "urgent" | "warm" | "window_end" | "gathered" }
  | { wake: false; at: number };

export function wakePaceDecision(facts: WakePaceFacts): WakePaceDecision {
  const gatherMs = facts.gatherMs && facts.gatherMs > 0 ? facts.gatherMs : 0;
  if (facts.coldBatchMs <= 0 && gatherMs <= 0) return { wake: true, why: "off" };
  if (facts.urgent) return { wake: true, why: "urgent" };
  // An event whose time is unknown, or lies in the future (a changed clock), counts as arrived now.
  const first = facts.firstWaitingAt !== null && facts.firstWaitingAt <= facts.now ? facts.firstWaitingAt : facts.now;
  const warm = facts.lastModelCallAt !== null && facts.now - facts.lastModelCallAt <= facts.warmMs;
  if (!warm && facts.coldBatchMs > 0) {
    const at = first + facts.coldBatchMs;
    return facts.now >= at ? { wake: true, why: "window_end" } : { wake: false, at };
  }
  if (gatherMs <= 0) return { wake: true, why: warm ? "warm" : "off" };
  const at = first + gatherMs;
  return facts.now >= at ? { wake: true, why: "gathered" } : { wake: false, at };
}

/** The line in the situation's "about you" section: how many model calls the system made by itself, and the pace. */
export function autoCallUsageLine(input: {
  callsLastHour: number; callsLastDay: number; uncachedTokensLastDay: number;
  limits: { callsPerHour: number; callsPerDay: number; uncachedTokensPerDay: number };
  coldBatchMinutes: number;
}): string {
  const of = (used: number, limit: number) => (limit > 0 ? `${used}/${limit}` : `${used}`);
  const tokens = (count: number) => (count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1_000 ? `${Math.round(count / 1_000)}K` : `${count}`);
  const uncached = input.limits.uncachedTokensPerDay > 0
    ? `${tokens(input.uncachedTokensLastDay)}/${tokens(input.limits.uncachedTokensPerDay)}` : tokens(input.uncachedTokensLastDay);
  const pace = input.coldBatchMinutes > 0 ? `缓存冷了以后攒 ${input.coldBatchMinutes} 分钟` : "不攒";
  return `系统自己叫醒你调的模型：最近一小时 ${of(input.callsLastHour, input.limits.callsPerHour)} 次，最近一天 ${of(input.callsLastDay, input.limits.callsPerDay)} 次，`
    + `没命中缓存的输入 ${uncached} token（斜杠后面是用户定的上限，到了系统就暂停自己调模型；只在用户这一轮要你改时用 auto_budget.set 改）。普通系统事件的节奏：${pace}（perform_action 的 wake_pace.set 可以调）。`;
}
