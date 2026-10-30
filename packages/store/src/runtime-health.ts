// 健康账本（spec D2，工单 03）。
// 账号和配置故障不属于工单，属于执行它的 profile。账本的一项管整个 profile（level='profile'），
// 或者只管"profile 加模型"（level='model'）。每次进入 unavailable 开启一次故障（incident）。
// 一次故障恰好给用户发一条通知（dedupKey 是故障 id），给 lead 留一条说明。
// 派发 gate 读这里：目标不可用时，请求挂起，不创建 Run。
// 恢复（工单 04）：到了退避的截止时间就跑不花钱的探针，探针通过就关闭故障，挂起的请求马上放行。
// 探针看不出的故障不自动探针，只等用户 plc recheck：账号停用，和没写重置时间的额度用完（engine 的 health-recovery.ts）。
// 2026-10-20 以前探针通过后还要先放一个"金丝雀"请求，它成功了才关闭故障。用户嫌它绕：一个 runtime 标记不可用了，
// 换一个就行。现在没有金丝雀；探针看不到的故障（例如余额）关闭后又同样失败时，并回刚关闭的那次故障，退避加倍，
// 不再通知（reopenProbeClosedIncident）。
import type { Db } from "./db.js";
import { localIso } from "@pi-lead-child/core";
import { addActivity } from "./activities.js";
import { addInbox } from "./inbox.js";
import { addNotification } from "./notifications.js";
import type { FailureNeeds, FailureRetry, FailureScope, Run, RuntimeId, TypedFailure } from "@pi-lead-child/core";
import {
  healthIncidentNextStep, healthLevel, recoversOnlyOnRecheck, runtimeFailureTitle, usageResetAt, usageResetUnknown,
  type HealthLevel,
} from "@pi-lead-child/runtime";
import { runtimeProfileKey, type RuntimeProfileIdentity } from "@pi-lead-child/runtime";

export type RuntimeHealthStatus = "healthy" | "degraded" | "unavailable";

export interface RuntimeIncident {
  id: number;
  profile_key: string;
  runtime: RuntimeId;
  executable: string;
  config_dir: string | null;
  level: HealthLevel;
  // level='model' 时是模型名，空串表示 CLI 的默认模型。level='profile' 时恒为空串。
  model: string;
  scope: "runtime" | "account";
  retry: FailureRetry;
  needs: FailureNeeds;
  code: string;
  evidence: string;
  opened_item_id: number | null;
  opened_run_id: number | null;
  opened_at: string;
  closed_at: string | null;
  close_reason: string | null;
  // 恢复状态（工单 04），见 schema.ts 的 RUNTIME_INCIDENT_RECOVERY_COLUMNS。
  next_probe_at: string | null;
  probe_failures: number;
  last_probe_at: string | null;
  last_probe_error: string | null;
  // 金丝雀的两列（2026-10-20 去掉金丝雀以后不再写）。旧数据里不为空的故障由恢复 tick 关闭（closeLegacyCanaryIncidents）。
  canary_armed_at: string | null;
  canary_run_id: number | null;
}

export interface RuntimeHealthEntry {
  profile_key: string;
  level: HealthLevel;
  model: string;
  runtime: RuntimeId;
  executable: string;
  config_dir: string | null;
  status: RuntimeHealthStatus;
  incident_id: number | null;
  recover_at: string | null;
  updated_at: string;
}

// 一个请求要去的目标：一个 profile 加一个模型。模型为空时，用 CLI 的默认模型。
export interface HealthTargetInput {
  profile: RuntimeProfileIdentity;
  model: string | null | undefined;
}

function incidentFailure(incident: RuntimeIncident): TypedFailure {
  return {
    scope: incident.scope, retry: incident.retry, needs: incident.needs,
    code: incident.code, evidence: incident.evidence,
  };
}

// 模型级故障的模型名。整个 profile 的故障没有模型；CLI 默认模型的故障也返回 null。
export function incidentModel(incident: Pick<RuntimeIncident, "level" | "model">): string | null {
  return incident.level === "model" ? incident.model || null : null;
}

export function runtimeIncidentTitle(incident: RuntimeIncident): string {
  const title = runtimeFailureTitle(incident.runtime, incidentFailure(incident));
  return incident.level === "model" ? `${title}（${incident.model || "默认模型"}）` : title;
}

// 写在挂起的派发请求上，lead 的查询工具和工单投影都读这一句。
export function runtimeSuspensionReason(incident: RuntimeIncident): string {
  // 用量额度用完时写出系统下一次重检的时间：报错里有重置时间时，就是那个时间（nextProbeAt）。
  // 没写重置时间的不自动重检（usageResetUnknown），不写时间。
  const reset = incident.code === "usage_limited" && incident.next_probe_at
    && !usageResetUnknown(incident, new Date(incident.opened_at))
    ? `系统 ${localIso(new Date(incident.next_probe_at))} 以后再重检。` : "";
  return `${runtimeIncidentTitle(incident)}（故障 #${incident.id}）。`
    + healthIncidentNextStep(incident.runtime, incidentFailure(incident)) + reset;
}

export function getRuntimeIncident(db: Db, id: number): RuntimeIncident | null {
  return db.prepare("SELECT * FROM runtime_incidents WHERE id=?").get(id) as RuntimeIncident | undefined ?? null;
}

// 派发 gate 的判断：目标不可用时，返回让它不可用的那次故障。
// profile 级的故障覆盖这个 profile 的所有模型。所以先看 profile 级，再看模型级。
export function unavailableIncident(db: Db, target: HealthTargetInput): RuntimeIncident | null {
  return db.prepare(
    `SELECT i.* FROM runtime_health h
     JOIN runtime_incidents i ON i.id = h.incident_id
     WHERE h.profile_key = ? AND h.status = 'unavailable' AND i.closed_at IS NULL
       AND (h.level = 'profile' OR (h.level = 'model' AND h.model = ?))
     ORDER BY CASE h.level WHEN 'profile' THEN 0 ELSE 1 END
     LIMIT 1`,
  ).get(runtimeProfileKey(target.profile), target.model ?? "") as RuntimeIncident | undefined ?? null;
}

// 选择 runtime 时还不知道模型，只看整个 profile 是否不可用。
export function unavailableProfileIncident(db: Db, profile: RuntimeProfileIdentity): RuntimeIncident | null {
  return db.prepare(
    `SELECT i.* FROM runtime_health h
     JOIN runtime_incidents i ON i.id = h.incident_id
     WHERE h.profile_key = ? AND h.level = 'profile' AND h.status = 'unavailable' AND i.closed_at IS NULL
     LIMIT 1`,
  ).get(runtimeProfileKey(profile)) as RuntimeIncident | undefined ?? null;
}

// ── 探针的退避（工单 04）────────────────────────────────────────────────────────
// 连续失败 n 次之后，下一次探针等 base·2ⁿ，最多等 max。
// 探针失败算一次失败。探针通过、故障关闭以后马上又同样失败，也算一次（并回那次故障）。
// 额度类故障探针看不出来，每一轮都会放出注定失败的 Run，所以上限不能太短。默认 1 分钟起，最多 1 小时。
export interface ProbeBackoff {
  baseMs: number;
  maxMs: number;
}

function positiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function probeBackoffConfig(env: Record<string, string | undefined> = process.env): ProbeBackoff {
  return {
    baseMs: positiveMs(env.PLC_RUNTIME_PROBE_BASE_MS, 60_000),
    maxMs: positiveMs(env.PLC_RUNTIME_PROBE_MAX_MS, 3_600_000),
  };
}

export function probeBackoffMs(failures: number, config: ProbeBackoff = probeBackoffConfig()): number {
  // 2 的 31 次方已经远超任何上限。先截断指数，避免溢出成 Infinity。
  return Math.min(config.baseMs * 2 ** Math.min(Math.max(failures, 0), 31), config.maxMs);
}

function after(at: string, ms: number): string {
  return new Date(Date.parse(at) + ms).toISOString();
}

// 下一次探针的时间。用量额度用完（usage_limited）而且报错里写了重置时间时，等到重置以后再探：
// 否则探针每次都通过（探针看不到额度），每个退避周期放出注定失败的 Run（2026-10-19 Run #111 写着 162 小时后重置）。
function nextProbeAt(at: string, backoffMs: number, failure: { code: string; evidence: string } | null): string {
  const backoff = after(at, backoffMs);
  if (failure?.code !== "usage_limited") return backoff;
  const reset = usageResetAt(failure.evidence, new Date(at));
  return reset && reset.toISOString() > backoff ? reset.toISOString() : backoff;
}

function clip(text: string, max: number): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// 状态的两个来源（spec D2）：一个真实 Run 的失败（被动），或者 claim 时的 preflight（主动，工单 05）。
// preflight 在创建 Run 之前运行，所以 runId 为空，dispatchRequestId 指出是哪一条派发请求没通过。
// 不是账本上的失败时返回 null。
// 账本的这一项已经有一次没关闭的故障时，这次失败并进那次故障，不发新的通知。
// leadNextStep：给 Lead 的下一步，写进开启故障时给 Lead 的那条说明（例如额度用完时用 recover_ticket_run 换 runtime）。
export function recordRuntimeHealthFailure(
  db: Db,
  args: HealthTargetInput & {
    failure: TypedFailure; itemId: number; runId: number | null; dispatchRequestId?: number; at?: Date;
    leadNextStep?: string;
  },
): { incident: RuntimeIncident; opened: boolean } | null {
  const level = healthLevel(args.failure);
  if (!level) return null;
  const { failure } = args;
  const key = runtimeProfileKey(args.profile);
  const model = level === "model" ? args.model ?? "" : "";
  const at = (args.at ?? new Date()).toISOString();
  const runId = args.runId ?? undefined;
  const requestId = args.dispatchRequestId ?? null;
  const write = (): { incident: RuntimeIncident; opened: boolean } => {
    const open = db.prepare(
      "SELECT * FROM runtime_incidents WHERE profile_key=? AND level=? AND model=? AND closed_at IS NULL",
    ).get(key, level, model) as RuntimeIncident | undefined;
    const reopened = open ? null : reopenProbeClosedIncident(db, { key, level, model, failure, at, itemId: args.itemId });
    if (reopened) {
      addActivity(db, {
        itemId: args.itemId, runId, actor: "system", kind: "decision",
        payload: {
          decision: "runtime_incident_recurred", incidentId: reopened.id, code: failure.code, reopened: true,
          ...(requestId !== null ? { dispatchRequestId: requestId } : {}),
        },
      });
      return { incident: reopened, opened: false };
    }
    if (open) {
      // 额度又撞上了，报错里有新的重置时间：探针等到那以后（只往后推，不提前）。
      const reset = failure.code === "usage_limited" ? usageResetAt(failure.evidence, new Date(at)) : null;
      const later = reset?.toISOString() ?? null;
      if (later && (open.next_probe_at === null || later > open.next_probe_at)) {
        db.prepare("UPDATE runtime_incidents SET next_probe_at=? WHERE id=?").run(later, open.id);
      }
      // 原来的证据没写重置时间、这一次写了：证据换成这一次的。恢复按证据判断重置时间是否已知（usageResetUnknown），
      // 不换的话，这次故障一直等用户重检（2026-10-29）。
      if (reset && usageResetUnknown(open, new Date(open.opened_at))) {
        db.prepare("UPDATE runtime_incidents SET evidence=? WHERE id=?").run(failure.evidence, open.id);
      }
      addActivity(db, {
        itemId: args.itemId, runId, actor: "system", kind: "decision",
        payload: {
          decision: "runtime_incident_recurred", incidentId: open.id, code: failure.code,
          ...(requestId !== null ? { dispatchRequestId: requestId } : {}),
        },
      });
      return { incident: open, opened: false };
    }
    // 第一次探针的截止时间在开启时就写成绝对时间。daemon 重启后只等剩下的时间。
    const inserted = db.prepare(
      `INSERT INTO runtime_incidents
       (profile_key, runtime, executable, config_dir, level, model, scope, retry, needs, code, evidence,
        opened_item_id, opened_run_id, opened_at, next_probe_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      key, args.profile.runtime, args.profile.executable, args.profile.configDir, level, model,
      failure.scope, failure.retry, failure.needs, failure.code, failure.evidence,
      args.itemId, args.runId, at, nextProbeAt(at, probeBackoffMs(0), failure),
    );
    const incident = getRuntimeIncident(db, Number(inserted.lastInsertRowid))!;
    db.prepare(
      `INSERT INTO runtime_health
       (profile_key, level, model, runtime, executable, config_dir, status, incident_id, recover_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unavailable', ?, NULL, ?)
       ON CONFLICT (profile_key, level, model) DO UPDATE SET
         status='unavailable', incident_id=excluded.incident_id, recover_at=NULL, updated_at=excluded.updated_at`,
    ).run(key, level, model, args.profile.runtime, args.profile.executable, args.profile.configDir, incident.id, at);
    const title = runtimeIncidentTitle(incident);
    const nextStep = healthIncidentNextStep(incident.runtime, failure);
    const origin = args.runId !== null
      ? `故障 #${incident.id}，首次出现在工单 #${args.itemId} 的 Run #${args.runId}。`
      : `故障 #${incident.id}，首次出现在工单 #${args.itemId} 的派发请求 #${requestId ?? "?"}。`
        + "preflight 没有通过，所以没有创建 Run。";
    // 用户通知不挂在某一张工单上：它说的是一个 profile，受影响的可能是很多张工单。
    // 2026-10-15 起只在要用户行动时发（重新登录、充值）：别的故障（模型被拒、配置错误）先交给 Lead，
    // Lead 换模型或换 runtime 让工作接着做；它处理不了时 daemon 再升级给用户（inbox.ts 的 escalateLeadRow）。
    const needsUser = failure.needs === "login" || failure.needs === "refill";
    if (needsUser) addNotification(db, {
      itemId: null,
      kind: "runtime_incident",
      urgency: "immediate",
      title: `${title}：派发已挂起`,
      body: [clip(failure.evidence, 300), `下一步：${nextStep}`, origin].filter(Boolean).join("\n"),
      createdAt: at,
      dedupKey: `runtime-incident:${incident.id}`,
    });
    // lead 的说明只有一条：attention（不向用户播报），但马上叫醒 Lead（wakeLead）。由 Lead 决定要不要换模型或换
    // runtime（recover_ticket_run）。说明里写出故障首次出现在哪张工单的哪个 Run，Lead 据此恢复。
    addInbox(db, {
      dedupScope: `runtime-incident:${incident.id}`,
      severity: "attention",
      source: "structural",
      summary: `${title}：派发已挂起（故障 #${incident.id}，首次出现在工单 #${args.itemId} 的${
        args.runId !== null ? ` Run #${args.runId}` : `派发请求 #${requestId ?? "?"}`
      }）`,
      payload: {
        kind: "runtime_incident",
        wakeLead: true,
        needsUser,
        incidentId: incident.id,
        runtime: incident.runtime,
        level: incident.level,
        model: incidentModel(incident),
        scope: incident.scope,
        needs: incident.needs,
        code: incident.code,
        nextStep,
        openedItemId: args.itemId,
        openedRunId: args.runId,
        openedRequestId: requestId,
        ...(args.leadNextStep ? { leadNextStep: args.leadNextStep } : {}),
      },
      lossless: true,
    });
    addActivity(db, {
      itemId: args.itemId, runId, actor: "system", kind: "decision",
      payload: {
        decision: "runtime_incident_opened", incidentId: incident.id, runtime: incident.runtime,
        level: incident.level, model: incidentModel(incident),
        scope: incident.scope, needs: incident.needs, code: incident.code,
        ...(requestId !== null ? { dispatchRequestId: requestId } : {}),
      },
    });
    return { incident, opened: true };
  };
  return db.inTransaction ? write() : db.transaction(write).immediate();
}

// 关闭一次故障，账本的这一项回到 healthy。挂起的请求在下一次 claim 时放行。
// 生产里探针通过（recordProbeResult）和关闭旧的金丝雀状态（closeLegacyCanaryIncidents）时调用它。
// lead 在故障开启时收到过一条说明。关闭时再给它一条，它就不会把已经恢复的故障说成还在挂起。
// 用户只在开启时收到一条通知（spec D2：每次故障恰好一条）。
export function resolveRuntimeIncident(
  db: Db,
  incidentId: number,
  args: { reason: string; at?: Date },
): boolean {
  const at = (args.at ?? new Date()).toISOString();
  return db.transaction(() => {
    const closed = db.prepare(
      "UPDATE runtime_incidents SET closed_at=?, close_reason=? WHERE id=? AND closed_at IS NULL",
    ).run(at, args.reason, incidentId).changes === 1;
    if (!closed) return false;
    db.prepare(
      "UPDATE runtime_health SET status='healthy', incident_id=NULL, updated_at=? WHERE incident_id=?",
    ).run(at, incidentId);
    const incident = getRuntimeIncident(db, incidentId)!;
    // 探针看不到的故障（余额、额度）：探针通过不等于恢复，不说「已恢复」，免得 Lead 转告用户（2026-10-21 审查）。
    const unconfirmed = PROBE_BLIND_CODES.has(incident.code);
    addInbox(db, {
      dedupScope: `runtime-incident:${incident.id}`,
      severity: "attention",
      source: "structural",
      summary: unconfirmed
        ? `${runtimeIncidentTitle(incident)}（故障 #${incident.id}）：${args.reason}，挂起的派发正在放行，结果待确认。`
          + "探针看不到余额和额度，同样的失败会重新开启这次故障。"
        : `${runtimeIncidentTitle(incident)}已恢复（故障 #${incident.id}）：${args.reason}。挂起的派发已放行。`,
      payload: {
        kind: "runtime_incident_closed",
        incidentId: incident.id,
        runtime: incident.runtime,
        level: incident.level,
        model: incidentModel(incident),
        reason: args.reason,
        ...(unconfirmed ? { unconfirmed: true } : {}),
      },
      lossless: true,
    });
    return true;
  }).immediate();
}

// ── 恢复（工单 04）─────────────────────────────────────────────────────────────
// 探针通过或用户重检通过时写的关闭原因。探针看不到的故障（余额、额度、某些凭据）关闭后马上又同样失败时，
// 按这些原因认出"刚被探针关闭的"故障，并回去（reopenProbeClosedIncident）。
export const PROBE_PASSED_REASON = "探针通过";
export const RECHECK_PASSED_REASON = "重检通过";
// 旧数据里停在金丝雀阶段的故障，恢复 tick 用这个原因关闭（它们的探针都已经通过了）。
export const LEGACY_CANARY_CLOSE_REASON = "探针已通过";
const PROBE_CLOSE_REASONS = [PROBE_PASSED_REASON, RECHECK_PASSED_REASON, LEGACY_CANARY_CLOSE_REASON];
// 探针看不到的故障：探针只查登录和模型，不花钱，查不到余额和用量额度。
const PROBE_BLIND_CODES: ReadonlySet<string> = new Set(["out_of_credits", "usage_limited"]);

// 一个目标上所有没关闭的故障。profile 级在前，模型级在后。
export function unavailableIncidents(db: Db, target: HealthTargetInput): RuntimeIncident[] {
  return db.prepare(
    `SELECT i.* FROM runtime_health h
     JOIN runtime_incidents i ON i.id = h.incident_id
     WHERE h.profile_key = ? AND h.status = 'unavailable' AND i.closed_at IS NULL
       AND (h.level = 'profile' OR (h.level = 'model' AND h.model = ?))
     ORDER BY CASE h.level WHEN 'profile' THEN 0 ELSE 1 END`,
  ).all(runtimeProfileKey(target.profile), target.model ?? "") as RuntimeIncident[];
}

// 探针刚关闭的故障又同样失败了（2026-10-20 去掉金丝雀时补的一条）：探针看不到余额和额度，关闭以后挂起的请求一起放出去，
// 又一起失败。每次开一次新故障，用户每一两分钟收到一条同样的通知，Lead 每次被叫醒。所以退避期内的同一项故障并回去：
// 重新开启，失败次数加一，下一次探针等两倍，不再通知用户。"退避期内"取退避的上限（默认 1 小时）。
function reopenProbeClosedIncident(
  db: Db,
  args: { key: string; level: HealthLevel; model: string; failure: TypedFailure; at: string; itemId: number },
): RuntimeIncident | null {
  const since = new Date(Date.parse(args.at) - probeBackoffConfig().maxMs).toISOString();
  const recent = db.prepare(
    `SELECT * FROM runtime_incidents
     WHERE profile_key=? AND level=? AND model=? AND closed_at IS NOT NULL AND closed_at >= ?
       AND close_reason IN (${PROBE_CLOSE_REASONS.map(() => "?").join(",")})
     ORDER BY id DESC LIMIT 1`,
  ).get(args.key, args.level, args.model, since, ...PROBE_CLOSE_REASONS) as RuntimeIncident | undefined;
  if (!recent || recent.code !== args.failure.code) return null;
  // 关闭以后又开了别的故障（同一项上的新故障更新）：不并回旧的。
  const newer = db.prepare(
    "SELECT 1 FROM runtime_incidents WHERE profile_key=? AND level=? AND model=? AND id > ? LIMIT 1",
  ).get(args.key, args.level, args.model, recent.id);
  if (newer) return null;
  const failures = recent.probe_failures + 1;
  // 这一次的报错写了重置时间、原来的没写：证据换成这一次的（见 recordRuntimeHealthFailure 的同一条规则）。
  const evidence = usageResetUnknown(recent, new Date(recent.opened_at)) && !usageResetUnknown(args.failure, new Date(args.at))
    ? args.failure.evidence
    : recent.evidence;
  db.prepare(
    `UPDATE runtime_incidents
     SET closed_at=NULL, close_reason=NULL, probe_failures=?, next_probe_at=?, last_probe_error=?, evidence=?
     WHERE id=?`,
  ).run(failures, nextProbeAt(args.at, probeBackoffMs(failures), args.failure),
    `探针通过以后又失败了（${args.failure.code}）`, evidence, recent.id);
  db.prepare(
    `UPDATE runtime_health SET status='unavailable', incident_id=?, recover_at=NULL, updated_at=?
     WHERE profile_key=? AND level=? AND model=?`,
  ).run(recent.id, args.at, args.key, args.level, args.model);
  const incident = getRuntimeIncident(db, recent.id)!;
  // 重新开启时告诉 Lead 一声，不通知用户。关闭时对 Lead 说过「已恢复」的（探针看得到的故障）叫醒它，
  // 免得它把已经恢复的话转告用户；关闭时只说了「结果待确认」的不叫醒（2026-10-21 审查）。
  addInbox(db, {
    dedupScope: `runtime-incident:${incident.id}`,
    severity: "attention",
    source: "structural",
    summary: `${runtimeIncidentTitle(incident)}：探针通过以后又同样失败，故障 #${incident.id} 重新开启，派发继续挂起`
      + `（工单 #${args.itemId}）。`,
    payload: {
      kind: "runtime_incident_reopened",
      incidentId: incident.id,
      runtime: incident.runtime,
      level: incident.level,
      model: incidentModel(incident),
      code: incident.code,
      probeFailures: failures,
      ...(PROBE_BLIND_CODES.has(incident.code) ? {} : { wakeLead: true }),
    },
    lossless: true,
  });
  return incident;
}

export function openRuntimeIncidents(db: Db, filter: { runtime?: RuntimeId } = {}): RuntimeIncident[] {
  return (filter.runtime
    ? db.prepare("SELECT * FROM runtime_incidents WHERE closed_at IS NULL AND runtime=? ORDER BY id").all(filter.runtime)
    : db.prepare("SELECT * FROM runtime_incidents WHERE closed_at IS NULL ORDER BY id").all()) as RuntimeIncident[];
}

// 到了探针时间的故障。next_probe_at 为空的是 v29 之前开启的故障，当作已经到期。
export function dueProbeIncidents(db: Db, at: Date): RuntimeIncident[] {
  return db.prepare(
    `SELECT * FROM runtime_incidents
     WHERE closed_at IS NULL AND (next_probe_at IS NULL OR next_probe_at <= ?)
     ORDER BY id`,
  ).all(at.toISOString()) as RuntimeIncident[];
}

// 探针检查哪个模型。模型级故障检查那个模型。profile 级故障检查开启故障的那个 Run 的模型。
export function incidentProbeModel(db: Db, incident: RuntimeIncident): string | null {
  if (incident.level === "model") return incident.model || null;
  if (incident.opened_run_id === null) return null;
  const run = db.prepare("SELECT model FROM runs WHERE id=?").get(incident.opened_run_id) as
    { model: string | null } | undefined;
  return run?.model ?? null;
}

// 记下一次探针的结果。通过时关闭故障，挂起的请求在下一次 claim 时放行。没通过时，退避加倍。
// 用户手动重检没通过时，不改自动探针的计划。用户多查几次，系统不应该因此等得更久。
// 探针运行期间，故障可能已经关闭。这时结果作废，返回 null。
export function recordProbeResult(
  db: Db,
  incidentId: number,
  args: { ok: boolean; detail: string | null; at: Date; manual?: boolean },
): RuntimeIncident | null {
  const at = args.at.toISOString();
  if (args.ok) {
    const current = getRuntimeIncident(db, incidentId);
    if (!current || current.closed_at !== null) return null;
    db.prepare("UPDATE runtime_incidents SET last_probe_at=?, last_probe_error=NULL WHERE id=? AND closed_at IS NULL")
      .run(at, incidentId);
    if (!resolveRuntimeIncident(db, incidentId, {
      reason: args.manual ? RECHECK_PASSED_REASON : PROBE_PASSED_REASON, at: args.at,
    })) return null;
    return getRuntimeIncident(db, incidentId);
  }
  return db.transaction((): RuntimeIncident | null => {
    const incident = getRuntimeIncident(db, incidentId);
    if (!incident || incident.closed_at !== null) return null;
    if (args.manual) {
      db.prepare("UPDATE runtime_incidents SET last_probe_at=?, last_probe_error=? WHERE id=?")
        .run(at, args.detail, incidentId);
    } else {
      const failures = incident.probe_failures + 1;
      db.prepare(
        `UPDATE runtime_incidents
         SET probe_failures=?, next_probe_at=?, last_probe_at=?, last_probe_error=? WHERE id=?`,
      ).run(failures, after(at, probeBackoffMs(failures)), at, args.detail, incidentId);
    }
    return getRuntimeIncident(db, incidentId);
  }).immediate();
}

// 探针这一轮说明不了什么时，推迟到下一个退避时间再探，不算一次失败。
// 例如 daemon 现在用的配置已经不是这次故障的配置（profile 换了）。
export function deferRuntimeProbe(db: Db, incidentId: number, args: { at: Date; detail: string }): void {
  const at = args.at.toISOString();
  db.transaction(() => {
    const incident = getRuntimeIncident(db, incidentId);
    if (!incident || incident.closed_at !== null) return;
    db.prepare("UPDATE runtime_incidents SET next_probe_at=?, last_probe_at=?, last_probe_error=? WHERE id=?")
      .run(after(at, probeBackoffMs(incident.probe_failures)), at, args.detail, incidentId);
  }).immediate();
}

// 2026-10-20 以前留下的金丝雀状态：探针已经通过（canary_armed_at）或者金丝雀已经派出（canary_run_id），故障还开着。
// 去掉金丝雀以后没有代码会再推进它们，所以恢复 tick 直接关闭它们。只关没关闭的，重复调用不会多关、多写。
// 关闭时同时清掉金丝雀字段：同样的失败会把故障并回去（reopenProbeClosedIncident），带着旧字段的故障会被下一次 tick
// 再关闭，挂起的派发又放出去撞同一个故障（2026-10-21 审查 H1）。
export function closeLegacyCanaryIncidents(db: Db, at: Date = new Date()): number[] {
  const rows = db.prepare(
    `SELECT id FROM runtime_incidents
     WHERE closed_at IS NULL AND (canary_armed_at IS NOT NULL OR canary_run_id IS NOT NULL)
     ORDER BY id`,
  ).all() as Array<{ id: number }>;
  const clear = db.prepare(
    "UPDATE runtime_incidents SET canary_armed_at=NULL, canary_run_id=NULL WHERE id=? AND closed_at IS NULL",
  );
  return rows
    .filter((row) => db.transaction(() => {
      clear.run(row.id);
      return resolveRuntimeIncident(db, row.id, { reason: LEGACY_CANARY_CLOSE_REASON, at });
    }).immediate())
    .map((row) => row.id);
}

// ── degraded（工单 06）─────────────────────────────────────────────────────────
// 瞬时失败的自动重试到了上限，profile 标成 degraded，并带一个绝对的恢复时间（spec D2、D5）。
// degraded 只是说明，不挂起派发，也不开启故障，所以不发用户通知。用户收到的是那张工单的 blocker。
// 已经 unavailable 的 profile 保持不变：那次故障更严重，恢复由探针决定。
export function markRuntimeDegraded(
  db: Db,
  args: { profile: RuntimeProfileIdentity; at: Date; recoverAt: Date },
): boolean {
  const at = args.at.toISOString();
  return db.prepare(
    `INSERT INTO runtime_health
     (profile_key, level, model, runtime, executable, config_dir, status, incident_id, recover_at, updated_at)
     VALUES (?, 'profile', '', ?, ?, ?, 'degraded', NULL, ?, ?)
     ON CONFLICT (profile_key, level, model) DO UPDATE SET
       status='degraded', recover_at=excluded.recover_at, updated_at=excluded.updated_at
     WHERE runtime_health.status <> 'unavailable'`,
  ).run(
    runtimeProfileKey(args.profile), args.profile.runtime, args.profile.executable, args.profile.configDir,
    args.recoverAt.toISOString(), at,
  ).changes === 1;
}

// 这个 profile 是不是在冷却：degraded，而且还没到恢复时间。返回恢复时间；不在冷却时返回 null。
// 派发不看它（degraded 不挂起派发）。选型建议（suggest_route）看它：冷却中的 runtime 不推荐。
export function runtimeCooldownUntil(db: Db, profile: RuntimeProfileIdentity, at: Date = new Date()): string | null {
  const row = db.prepare(
    `SELECT recover_at FROM runtime_health
     WHERE profile_key = ? AND level = 'profile' AND status = 'degraded' AND recover_at IS NOT NULL AND recover_at > ?`,
  ).get(runtimeProfileKey(profile), at.toISOString()) as { recover_at: string } | undefined;
  return row?.recover_at ?? null;
}

// lead 的健康查询读这里：账本里不健康的项，以及让它们不健康的故障。
// degraded 过了恢复时间就不再列出：它只说明那段时间里瞬时失败很多。
export function listUnhealthyRuntimeTargets(db: Db): Array<RuntimeHealthEntry & { incident: RuntimeIncident | null }> {
  const rows = db.prepare(
    `SELECT * FROM runtime_health
     WHERE status = 'unavailable' OR (status = 'degraded' AND (recover_at IS NULL OR recover_at > ?))
     ORDER BY runtime, profile_key, level, model`,
  ).all(new Date().toISOString()) as RuntimeHealthEntry[];
  return rows.map((row) => ({
    ...row,
    incident: row.incident_id === null ? null : getRuntimeIncident(db, row.incident_id),
  }));
}
