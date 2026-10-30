// 后台检查（.scratch/lead-watch/spec.md）。用户 2026-10-28：Lead 要能自己定时刷新登录；外部系统不发事件时，
// Lead 要派人去盯，而不是说一句「我会盯着」就结束这一轮。
//
// 这里是存储和「检查完以后怎样」的判断（decideAfterCheck，纯函数）。跑命令、开子 agent、叫醒 Lead 在 engine 的
// watch-runner.ts。一个检查：
//   - command：一条命令，退出码 0 算通过（pass），非 0 或超时算没通过（fail），跑不起来算出错（error）。
//   - agent：一个轻子 agent。until 只开一个，由它自己在期限内反复检查；repeat 每次开一个。交回时由 Run 结束的说明叫醒 Lead。
// 两种方式：
//   - until：检查到通过或到期为止。通过、到期、连续出错 3 次时叫醒 Lead，检查结束。
//   - repeat：按 cron 或间隔一直检查，直到取消。只在状态变化时叫醒 Lead：第一次没通过、从通过变成没通过、恢复成通过。
// running_since 不为空时这个检查正在跑，不会再开一次（命令跑完、子 agent 交回时清掉）。
import { localTz } from "@pi-lead-child/core";
import type { TimerOrigin } from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { nextRun } from "./triggers.js";
import type { FollowUpSetBy } from "./user-turn-authority.js";

export type WatchCheckKind = "command" | "agent";
export type WatchMode = "until" | "repeat";
export type WatchStatus = "pass" | "fail" | "error";
export type WatchState = "waiting" | "done" | "cancelled";
// 为什么叫醒 Lead。agent_failed：子代理检查开不起来（例如今天的 token 用完了）。
export type WatchWake = "passed" | "failed" | "recovered" | "expired" | "errors" | "agent_failed";
// 检查为什么结束（until 的通过、到期、连续出错，子代理检查交回）。
export type WatchEnd = "passed" | "expired" | "errors" | "agent_done" | "cancelled";

export interface Watch {
  id: number;
  label: string;
  check_kind: WatchCheckKind;
  command: string | null;
  brief: string | null;
  agent_json: string | null;
  mode: WatchMode;
  every_seconds: number | null;
  cron_expr: string | null;
  cron_tz: string | null;
  until_at: string | null;
  note: string;
  item_id: number | null;
  origin_json: string;
  set_by_json: string | null;
  state: WatchState;
  ended_reason: string | null;
  next_check_at: string | null;
  running_since: string | null;
  last_status: WatchStatus | null;
  last_checked_at: string | null;
  last_output: string | null;
  check_count: number;
  consecutive_errors: number;
  created_at: string;
  updated_at: string;
}

export interface WatchCheck {
  id: number;
  watch_id: number;
  started_at: string;
  finished_at: string | null;
  status: "running" | WatchStatus;
  exit_code: number | null;
  output: string | null;
  item_id: number | null;
  woke: WatchWake | null;
}

/** 子代理检查用哪个执行者（缺省由派发按目录选）。 */
export interface WatchAgentChoice {
  runtime?: "pi" | "codex" | "claude";
  model?: string;
  effort?: string;
}

// 底线（spec D5，用户 2026-10-28 采纳）。数字是给模型和用户看的说明里写的那些，改的时候一起改。
export const WATCH_LIMITS = {
  // 命令检查最短间隔（秒）。子代理检查 until 时这是子 agent 自己检查的间隔，下限一样。
  minEverySeconds: 10,
  // 子代理检查 repeat 时两次之间最短（秒）：每次都开一个子 agent，要花 token。
  minAgentRepeatSeconds: 30 * 60,
  // until 最长：命令检查 7 天，子代理检查 24 小时。
  maxCommandUntilMs: 7 * 24 * 60 * 60 * 1000,
  maxAgentUntilMs: 24 * 60 * 60 * 1000,
  // 一次命令最多跑多久（秒）、输出留多少字。
  commandTimeoutSeconds: 120,
  outputChars: 2_000,
  // 每个检查留最近几次的记录。
  keepChecks: 50,
  // until 连续出错几次就停。
  maxConsecutiveErrors: 3,
  // 同时在等的检查最多几个（PLC_WATCH_MAX_ACTIVE）。
  maxActive: 20,
  // 子代理检查最近 24 小时合计的 token 上限（PLC_WATCH_AGENT_DAILY_TOKENS）。
  agentDailyTokens: 2_000_000,
} as const;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function watchMaxActive(env: Record<string, string | undefined> = process.env): number {
  return positiveInt(env.PLC_WATCH_MAX_ACTIVE, WATCH_LIMITS.maxActive);
}

export function watchAgentDailyTokens(env: Record<string, string | undefined> = process.env): number {
  return positiveInt(env.PLC_WATCH_AGENT_DAILY_TOKENS, WATCH_LIMITS.agentDailyTokens);
}

/** 设检查时参数不对：给 Lead 的话写清哪里不对、该怎么改。 */
export class WatchInputError extends Error {}

export interface CreateWatchInput {
  label: string;
  check: { kind: "command"; command: string } | { kind: "agent"; brief: string; agent?: WatchAgentChoice };
  mode: WatchMode;
  everySeconds?: number;
  cron?: string;
  tz?: string;
  untilAt?: string;
  note?: string;
  itemId?: number;
  origin: TimerOrigin;
  setBy?: FollowUpSetBy | null;
  maxActive?: number;
}

function addSeconds(at: Date, seconds: number): Date {
  return new Date(at.getTime() + seconds * 1000);
}

function minutes(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}

/** 校验参数并建一个检查。第一次检查：until 和按间隔的 repeat 马上查，按 cron 的 repeat 在下一个时刻查。 */
export function createWatch(db: Db, input: CreateWatchInput, now: Date = new Date()): number {
  const label = input.label.trim();
  if (!label) throw new WatchInputError("label 不能是空的：写这个检查盯的是什么，例如「clime 登录」");
  const agent = input.check.kind === "agent";
  const text = input.check.kind === "command" ? input.check.command.trim() : input.check.brief.trim();
  if (!text) throw new WatchInputError(agent ? "子代理检查要写 brief：看什么、怎样算有结果" : "命令检查要写 command");
  const every = input.everySeconds;
  if (every !== undefined && (!Number.isInteger(every) || every < WATCH_LIMITS.minEverySeconds)) {
    throw new WatchInputError(`every_seconds 最少 ${WATCH_LIMITS.minEverySeconds} 秒`);
  }
  let untilAt: string | null = null;
  let tz: string | null = null;
  let next: string;
  if (input.mode === "until") {
    if (every === undefined) throw new WatchInputError("mode='until' 要写 every_seconds：多久查一次");
    if (input.cron) throw new WatchInputError("mode='until' 按间隔检查，不用 cron");
    const until = input.untilAt ? new Date(input.untilAt) : null;
    if (!until || Number.isNaN(until.getTime())) throw new WatchInputError("mode='until' 要写 until：最晚查到什么时候（ISO 时间）");
    if (until.getTime() <= now.getTime()) throw new WatchInputError(`until（${input.untilAt}）已经过去了`);
    const max = agent ? WATCH_LIMITS.maxAgentUntilMs : WATCH_LIMITS.maxCommandUntilMs;
    if (until.getTime() - now.getTime() > max) {
      throw new WatchInputError(agent ? "子代理检查的 until 最长 24 小时" : "命令检查的 until 最长 7 天");
    }
    untilAt = until.toISOString();
    next = now.toISOString();
  } else {
    if (input.untilAt) throw new WatchInputError("mode='repeat' 一直检查到取消，不写 until");
    if (Boolean(input.cron) === (every !== undefined)) throw new WatchInputError("mode='repeat' 写 cron 或 every_seconds，只写一个");
    if (input.cron) {
      tz = input.tz ?? localTz();
      let first: string;
      try {
        first = nextRun(input.cron, now, tz);
      } catch (error) {
        throw new WatchInputError(`cron 不对：${error instanceof Error ? error.message : String(error)}`);
      }
      if (agent) {
        const gap = (new Date(nextRun(input.cron, new Date(first), tz)).getTime() - new Date(first).getTime()) / 1000;
        if (gap < WATCH_LIMITS.minAgentRepeatSeconds) {
          throw new WatchInputError(`子代理检查每次都开一个子 agent，两次之间最少 ${minutes(WATCH_LIMITS.minAgentRepeatSeconds)}`);
        }
      }
      next = first;
    } else {
      if (agent && every! < WATCH_LIMITS.minAgentRepeatSeconds) {
        throw new WatchInputError(`子代理检查每次都开一个子 agent，every_seconds 最少 ${WATCH_LIMITS.minAgentRepeatSeconds}`);
      }
      next = now.toISOString();
    }
  }
  const max = input.maxActive ?? WATCH_LIMITS.maxActive;
  if (countWaitingWatches(db) >= max) {
    throw new WatchInputError(`在等的后台检查已经有 ${max} 个了：先取消用不着的（perform_action，target_type='timer'，action='cancel'）`);
  }
  const nowIso = now.toISOString();
  const result = db.prepare(
    `INSERT INTO watches (label, check_kind, command, brief, agent_json, mode, every_seconds, cron_expr, cron_tz, until_at, note,
       item_id, origin_json, set_by_json, next_check_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    label.slice(0, 200), input.check.kind,
    input.check.kind === "command" ? text : null,
    input.check.kind === "agent" ? text : null,
    input.check.kind === "agent" && input.check.agent ? JSON.stringify(input.check.agent) : null,
    input.mode, every ?? null, input.cron ?? null, tz, untilAt, (input.note ?? "").trim(),
    input.itemId ?? null, JSON.stringify(input.origin), input.setBy ? JSON.stringify(input.setBy) : null,
    next, nowIso, nowIso,
  );
  return Number(result.lastInsertRowid);
}

export function getWatch(db: Db, id: number): Watch | undefined {
  return db.prepare("SELECT * FROM watches WHERE id = ?").get(id) as Watch | undefined;
}

export function listWatches(db: Db, opts: { waitingOnly?: boolean } = {}): Watch[] {
  return db.prepare(
    `SELECT * FROM watches ${opts.waitingOnly ? "WHERE state = 'waiting'" : ""} ORDER BY state <> 'waiting', next_check_at IS NULL, next_check_at, id`,
  ).all() as Watch[];
}

export function countWaitingWatches(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM watches WHERE state = 'waiting'").get() as { n: number }).n;
}

export function listWatchChecks(db: Db, watchId: number, limit = 10): WatchCheck[] {
  return db.prepare("SELECT * FROM watch_checks WHERE watch_id = ? ORDER BY id DESC LIMIT ?").all(watchId, limit) as WatchCheck[];
}

/** 到点、没在跑的检查。 */
export function dueWatches(db: Db, now: Date): Watch[] {
  return db.prepare(
    "SELECT * FROM watches WHERE state = 'waiting' AND running_since IS NULL AND next_check_at <= ? ORDER BY next_check_at, id",
  ).all(now.toISOString()) as Watch[];
}

/** 占住这一次检查：记下正在跑，写一行检查记录。已经有人在跑、或者检查已经结束时返回 null。 */
export function startWatchCheck(db: Db, watchId: number, now: Date): number | null {
  return db.transaction((): number | null => {
    const claimed = db.prepare(
      "UPDATE watches SET running_since = ?, updated_at = ? WHERE id = ? AND state = 'waiting' AND running_since IS NULL",
    ).run(now.toISOString(), now.toISOString(), watchId);
    if (claimed.changes === 0) return null;
    const row = db.prepare("INSERT INTO watch_checks (watch_id, started_at) VALUES (?, ?)").run(watchId, now.toISOString());
    return Number(row.lastInsertRowid);
  })();
}

/** 子代理检查开出来的轻工单。 */
export function attachWatchCheckItem(db: Db, checkId: number, itemId: number): void {
  db.prepare("UPDATE watch_checks SET item_id = ? WHERE id = ?").run(itemId, checkId);
}

export interface WatchDecision {
  wake: WatchWake | null;
  end: WatchEnd | null;
  nextCheckAt: string | null;
  consecutiveErrors: number;
}

/**
 * 一次检查以后怎样（决策边界，spec D3）：要不要叫醒 Lead、检查结束没有、下一次什么时候。
 * agent：子代理检查交回了（status 是它的结局）或者没开起来（agentFailed）。子 agent 交回由 Run 结束的说明叫醒 Lead，这里不再叫醒。
 */
export function decideAfterCheck(
  watch: Pick<Watch, "check_kind" | "mode" | "every_seconds" | "cron_expr" | "cron_tz" | "until_at" | "last_status" | "consecutive_errors">,
  status: WatchStatus, now: Date, opts: { agentFailed?: boolean } = {},
): WatchDecision {
  const consecutiveErrors = status === "error" ? watch.consecutive_errors + 1 : 0;
  const next = (): string => (watch.cron_expr
    ? nextRun(watch.cron_expr, now, watch.cron_tz ?? localTz())
    : addSeconds(now, watch.every_seconds ?? WATCH_LIMITS.minEverySeconds).toISOString());
  if (watch.mode === "until") {
    if (watch.check_kind === "agent") {
      return { wake: opts.agentFailed ? "agent_failed" : null, end: opts.agentFailed ? "errors" : "agent_done", nextCheckAt: null, consecutiveErrors };
    }
    if (status === "pass") return { wake: "passed", end: "passed", nextCheckAt: null, consecutiveErrors };
    if (consecutiveErrors >= WATCH_LIMITS.maxConsecutiveErrors) return { wake: "errors", end: "errors", nextCheckAt: null, consecutiveErrors };
    const until = new Date(watch.until_at ?? now.toISOString());
    if (now.getTime() >= until.getTime()) return { wake: "expired", end: "expired", nextCheckAt: null, consecutiveErrors };
    const after = addSeconds(now, watch.every_seconds ?? WATCH_LIMITS.minEverySeconds);
    return { wake: null, end: null, nextCheckAt: (after.getTime() > until.getTime() ? until : after).toISOString(), consecutiveErrors };
  }
  // repeat：通过和「没通过、出错」是两种状态，只在两种状态之间变化时叫醒（第一次就没通过也算）。
  const wasPassing = watch.last_status === "pass";
  const wasFirst = watch.last_status === null;
  let wake: WatchWake | null = null;
  if (opts.agentFailed) wake = wasPassing || wasFirst ? "agent_failed" : null;
  else if (watch.check_kind === "agent") wake = null;
  else if (status === "pass") wake = wasFirst || wasPassing ? null : "recovered";
  else wake = wasFirst || wasPassing ? "failed" : null;
  return { wake, end: null, nextCheckAt: next(), consecutiveErrors };
}

function clipOutput(output: string | null | undefined): string | null {
  if (output === null || output === undefined) return null;
  const chars = [...output];
  return chars.length > WATCH_LIMITS.outputChars ? `…${chars.slice(-WATCH_LIMITS.outputChars).join("")}` : output;
}

export interface FinishedWatchCheck {
  watch: Watch;
  check: WatchCheck;
  decision: WatchDecision;
}

/**
 * 一次检查结束：记下结果，按 decideAfterCheck 定下一步。检查在跑的时候被取消了：只记结果，不叫醒，不改状态。
 * 找不到这一次检查、或者它已经记过结果时返回 null（同一次只记一次）。
 */
export function finishWatchCheck(
  db: Db, args: { checkId: number; status: WatchStatus; exitCode?: number | null; output?: string | null; agentFailed?: boolean; now: Date },
): FinishedWatchCheck | null {
  return db.transaction((): FinishedWatchCheck | null => {
    const check = db.prepare("SELECT * FROM watch_checks WHERE id = ?").get(args.checkId) as WatchCheck | undefined;
    if (!check || check.status !== "running") return null;
    const watch = getWatch(db, check.watch_id)!;
    const nowIso = args.now.toISOString();
    const output = clipOutput(args.output);
    const waiting = watch.state === "waiting";
    const decision = waiting
      ? decideAfterCheck(watch, args.status, args.now, { agentFailed: args.agentFailed })
      : { wake: null, end: null, nextCheckAt: null, consecutiveErrors: watch.consecutive_errors };
    db.prepare("UPDATE watch_checks SET finished_at = ?, status = ?, exit_code = ?, output = ?, woke = ? WHERE id = ?")
      .run(nowIso, args.status, args.exitCode ?? null, output, decision.wake, check.id);
    if (waiting) {
      db.prepare(
        `UPDATE watches SET running_since = NULL, last_status = ?, last_checked_at = ?, last_output = ?, check_count = check_count + 1,
           consecutive_errors = ?, state = ?, ended_reason = ?, next_check_at = ?, updated_at = ? WHERE id = ?`,
      ).run(
        args.status, nowIso, output, decision.consecutiveErrors, decision.end ? "done" : "waiting", decision.end,
        decision.end ? null : decision.nextCheckAt, nowIso, watch.id,
      );
    } else {
      db.prepare("UPDATE watches SET running_since = NULL, updated_at = ? WHERE id = ?").run(nowIso, watch.id);
    }
    db.prepare(
      `DELETE FROM watch_checks WHERE watch_id = ? AND id NOT IN (SELECT id FROM watch_checks WHERE watch_id = ? ORDER BY id DESC LIMIT ?)`,
    ).run(watch.id, watch.id, WATCH_LIMITS.keepChecks);
    return { watch: getWatch(db, watch.id)!, check: db.prepare("SELECT * FROM watch_checks WHERE id = ?").get(check.id) as WatchCheck, decision };
  })();
}

/** 取消：以后不再检查。正在跑的这一次照常跑完（子 agent 有期限），结果只记下，不叫醒。已经结束的返回 false。 */
export function cancelWatch(db: Db, id: number, args: { reason: string; at?: Date }): boolean {
  const at = (args.at ?? new Date()).toISOString();
  return db.prepare(
    "UPDATE watches SET state = 'cancelled', ended_reason = ?, next_check_at = NULL, updated_at = ? WHERE id = ? AND state = 'waiting'",
  ).run(`cancelled: ${args.reason}`.slice(0, 500), at, id).changes > 0;
}

/** 这张工单是不是哪个子代理检查开的。 */
export function watchCheckOfItem(db: Db, itemId: number): { watch: Watch; check: WatchCheck } | null {
  const check = db.prepare("SELECT * FROM watch_checks WHERE item_id = ? ORDER BY id DESC LIMIT 1").get(itemId) as WatchCheck | undefined;
  if (!check) return null;
  const watch = getWatch(db, check.watch_id);
  return watch ? { watch, check } : null;
}

/**
 * 这一次检查没跑完就断了（daemon 重启，spec D8）：记成出错，但不算进连续出错、不叫醒、不改上一次的结果，
 * 检查还在等的话马上重查。重启不是检查对象的问题。
 */
export function abandonWatchCheck(db: Db, checkId: number, args: { reason: string; now: Date }): boolean {
  return db.transaction((): boolean => {
    const check = db.prepare("SELECT * FROM watch_checks WHERE id = ?").get(checkId) as WatchCheck | undefined;
    if (!check || check.status !== "running") return false;
    const nowIso = args.now.toISOString();
    db.prepare("UPDATE watch_checks SET finished_at = ?, status = 'error', output = ? WHERE id = ?").run(nowIso, args.reason, checkId);
    db.prepare(
      `UPDATE watches SET running_since = NULL, next_check_at = CASE WHEN state = 'waiting' THEN ? ELSE NULL END, updated_at = ?
       WHERE id = ?`,
    ).run(nowIso, nowIso, check.watch_id);
    return true;
  })();
}

/** 正在跑的检查：daemon 重启以后要接着处理（spec D8）。 */
export function runningWatchChecks(db: Db): Array<{ watch: Watch; check: WatchCheck }> {
  const checks = db.prepare("SELECT * FROM watch_checks WHERE status = 'running' ORDER BY id").all() as WatchCheck[];
  return checks.map((check) => ({ watch: getWatch(db, check.watch_id)!, check }));
}

/** 子代理检查最近花了多少 token：since 以后开的轻工单的 total_tokens 合计。 */
export function agentWatchTokensSince(db: Db, since: Date): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(items.total_tokens), 0) AS n FROM watch_checks JOIN items ON items.id = watch_checks.item_id
     WHERE watch_checks.started_at >= ?`,
  ).get(since.toISOString()) as { n: number };
  return row.n;
}

export function watchOrigin(watch: Watch): TimerOrigin {
  try {
    return JSON.parse(watch.origin_json) as TimerOrigin;
  } catch {
    return { kind: "system" };
  }
}

export function watchAgentChoice(watch: Watch): WatchAgentChoice {
  if (!watch.agent_json) return {};
  try {
    return JSON.parse(watch.agent_json) as WatchAgentChoice;
  } catch {
    return {};
  }
}
