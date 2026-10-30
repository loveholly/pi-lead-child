// 创建 Run 的唯一硬闸门（spec §6.5）。
// 工具拆分负责"好用"，这里负责"不可能错"：即便工具写错、Trigger 配错、重试路径有 bug，
// 也造不出"提醒被执行"或"未确认就开跑"的状态。所以它落在 createRun 里而不是调用方——
// 落在调用方就等于每新增一条派发路径都要重新记得抄一遍，而漏抄不会有任何报错。
//
// 三种 Run 的合法 stage 不同，现有代码已如此：children/manager.ts 要求 reviewer 时
// stage='review'，要求 integration 时 plan_state='integrating'。把这三条分支
// 合并成一条"执行 Run 的条件"会让 role='reviewer' 结构上无法创建，等于删掉整条自动评审管线。
import { isHostOutcomeRegistrationDefect } from "./attention.js";
import type { Db } from "./db.js";
import type { ItemStage, Run, RunPurpose } from "@pi-lead-child/core";
import { assertTicketRelationsAllowRun } from "./ticket-relations.js";
import { addActivity } from "./activities.js";
import { chargesRetryBudget } from "@pi-lead-child/runtime";
import { runFailure } from "@pi-lead-child/runtime";

// draft 不在其中，这正是"建完先别跑"的落点：确认（draft → ready）只有 user 做得到（§6.4），
// 于是"未确认就开跑"在结构上不可达，而不是靠调用方自觉。
const EXECUTOR_STAGES = ["ready", "active", "blocked"];

// ——— 重试预算（spec §7.1）———
//
// 「Run crashed」的通知一直是好的，缺的是**刹车**：重试次数用尽之后没有任何东西说"这条线
// 到此为止"，于是 lead 一次次重开，同一件事烧掉三个 Run 又多出两张工单。预算耗尽必须让
// 派发在结构上不可能，而不是靠提示词自律——所以它落在闸门里，和"未确认就开跑"同一层：
// lead 的 spawn_child、scheduler、编排器、createRun，每一条路都过这里。
//
// retry_limit 是**重试**次数，不是总次数：limit=1 → 首跑 + 1 次重试 = 2 次执行；
// limit=0 → 崩了就停。判据 failures > retryLimit 与 orchestrator 里 reviewer 那套
// （failures <= retryLimit 才续）是同一个算法，两边不能各算各的。
export interface ExecutorRetryBudget {
  failures: number;
  retryLimit: number;
  exhausted: boolean;
}

// 只有 scope 为 task 或 unknown 的失败扣额度（spec D1）。账号、配置、瞬时和宿主故障都不是
// 这张工单的业务尝试：故障修好以后，工单还要能正常重试。
// 没有类型的旧 Run 走兜底分类器，用的是同一张映射表。

export function executorRetryBudget(db: Db, itemId: number): ExecutorRetryBudget {
  // retry_limit 可空（reminder 恒为 NULL）；task 的建单缺省是 1，用同一个数兜底。
  const item = db.prepare("SELECT retry_limit FROM items WHERE id = ?").get(itemId) as
    { retry_limit: number | null } | undefined;
  const retryLimit = item?.retry_limit ?? 1;
  // 只数 purpose='execution'：integration 与 review 各有自己的重试通路，把它们的失败
  // 记在执行预算上，会让一次集成失败把还没跑过的执行也一并锁死。
  // 也只数 'failed'：'stopped' 是用户或 lead 主动中止，不该消耗他自己的重试额度。
  const failedRuns = db.prepare(
    `SELECT * FROM runs
     WHERE item_id = ? AND role = 'executor' AND purpose = 'execution' AND state = 'failed'`,
  ).all(itemId) as Run[];
  const failures = failedRuns.filter((run) => chargesRetryBudget(runFailure(run))).length;
  return { failures, retryLimit, exhausted: failures > retryLimit };
}

// 启动修复。旧代码按旧规则扣光了额度，把 plan_state 置成 failed。这里按 scope 规则重新判断：
// 最近一次执行失败不扣额度、重算后也没耗尽，就解除停止。只看 plan_state='failed' 的工单，所以有界；
// 修过的工单 plan_state 变成 none，再跑一次不会重复修，所以幂等。
export function repairNonBudgetRetryExhaustion(db: Db): number {
  const rows = db.prepare(
    `SELECT i.id FROM items i
     WHERE i.kind='task' AND i.plan_state='failed' AND i.active_plan_revision IS NULL`,
  ).all() as Array<{ id: number }>;
  const latestRun = db.prepare(
    `SELECT * FROM runs
     WHERE item_id=? AND role='executor' AND purpose='execution' AND error_code IS NOT 'run_start_refused'
     ORDER BY id DESC LIMIT 1`,
  );
  let repaired = 0;
  for (const row of rows) {
    const latest = latestRun.get(row.id) as Run | undefined;
    if (!latest || chargesRetryBudget(runFailure(latest))) continue;
    const budget = executorRetryBudget(db, row.id);
    if (budget.exhausted) continue;
    db.transaction(() => {
      db.prepare(
        "UPDATE items SET plan_state='none', updated_at=datetime('now') WHERE id=? AND plan_state='failed'",
      ).run(row.id);
      addActivity(db, {
        itemId: row.id,
        actor: "system",
        kind: "decision",
        payload: {
          decision: "retry_exhaustion_repaired",
          reason: "latest execution failure is not a task or unknown failure and does not consume the retry budget",
          errorCode: latest.error_code,
          failures: budget.failures,
          retryLimit: budget.retryLimit,
        },
      });
    }).immediate();
    repaired += 1;
  }
  return repaired;
}

interface LatestExecutorRun {
  id: number;
  error_code: string | null;
  error_message: string | null;
  ended_at: string | null;
}

// 没启动成的 Run（run_start_refused）不算：它没有开始，不是一次执行（发布评审 reliability-backlog 复核）。
function latestExecutorExecutionRun(db: Db, itemId: number): LatestExecutorRun | null {
  return db.prepare(
    `SELECT id, error_code, error_message, ended_at
     FROM runs
     WHERE item_id=? AND role='executor' AND purpose='execution' AND error_code IS NOT 'run_start_refused'
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId) as LatestExecutorRun | undefined ?? null;
}

// 两种 blocker 都表示同一类宿主缺陷：Run 已经 finished，但登记没有完成。
// 登记待处理来自工单 07（spec D3）。成果登记成功时，两种 blocker 都会被撤回，闸门随之放行。
function hasHostRegistrationBlocker(db: Db, itemId: number, runId: number): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM inbox
     WHERE item_id=?
       AND json_extract(payload, '$.blockerCode') IN ('invalid_outcome_envelope', 'registration_pending')
       AND json_extract(payload, '$.runId')=?
     LIMIT 1`,
  ).get(itemId, runId));
}

function hasUserRetryAuthorizationAfter(db: Db, itemId: number, run: LatestExecutorRun): boolean {
  const after = run.ended_at
    ?? (db.prepare(
      "SELECT MAX(created_at) AS at FROM activities WHERE run_id=?",
    ).get(run.id) as { at: string | null }).at
    ?? "1970-01-01 00:00:00";
  return Boolean(db.prepare(
    `SELECT 1 FROM activities
     WHERE item_id=? AND actor='user' AND kind='decision'
       AND json_extract(payload, '$.decision')='retry_authorized'
       AND created_at>=?
     LIMIT 1`,
  ).get(itemId, after));
}

export function hostOutcomeRegistrationHalt(
  db: Db,
  itemId: number,
): { runId: number } | null {
  const run = latestExecutorExecutionRun(db, itemId);
  if (!run) return null;
  const blocked = hasHostRegistrationBlocker(db, itemId, run.id)
    || isHostOutcomeRegistrationDefect({
      errorCode: run.error_code,
      errorMessage: run.error_message,
    });
  if (!blocked) return null;
  if (hasUserRetryAuthorizationAfter(db, itemId, run)) return null;
  return { runId: run.id };
}

// ——— 成果修复回合（spec D4，工单 09）———
//
// 成果没有交好的三种 blocker：交接工具没被调用、成果缺失、成果信封无效。它们触发修复回合。
export const OUTCOME_FAILURE_BLOCKER_CODES = [
  "terminal_handoff_failed",
  "outcome_registration_missing",
  "invalid_outcome_envelope",
] as const;

// 登记相关的 blocker：Run 已经 finished，但成果没有登记。闸门在这几种 blocker 上放行修复回合。
// registration_pending 来自工单 07：登记的某一步抛错。这时成果也没有登记。
export const REGISTRATION_BLOCKER_CODES = [...OUTCOME_FAILURE_BLOCKER_CODES, "registration_pending"] as const;

const MAX_OUTCOME_REPAIR_LIMIT = 5;

/**
 * 每个执行 Run 最多几个修复回合。默认一次，和执行重试额度分开计算。
 * PLC_OUTCOME_REPAIR_LIMIT 可以设成 0 到 5 的整数。0 表示关闭修复回合。大于 5 时按 5 处理，其他值按默认处理。
 */
export function outcomeRepairLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PLC_OUTCOME_REPAIR_LIMIT?.trim();
  if (!raw || !/^\d+$/.test(raw)) return 1;
  return Math.min(Number(raw), MAX_OUTCOME_REPAIR_LIMIT);
}

/**
 * 来源 Run 已经用掉的修复回合。修复回合总是 resume 来源 Run 的 session，所以 resumed_from_run_id 就是来源 Run。
 * 闸门只数已经结束的修复回合（onlyEnded），并且不数正在检查的那一个（exceptRunId）：
 * 刚建好、还在 starting 的修复回合，和刚结束、正在登记的修复回合，都不能把自己算进去。
 * 没启动成的修复回合（run_start_refused）也不数：它没有开始，请求会退避后再派（发布评审 reliability-backlog）。
 */
export function outcomeRepairRunsUsed(
  db: Db,
  sourceRunId: number,
  options: { onlyEnded?: boolean; exceptRunId?: number } = {},
): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM runs
     WHERE purpose='outcome_repair' AND resumed_from_run_id=? AND id <> ?
       AND error_code IS NOT 'run_start_refused'
       AND (? = 0 OR state IN ('finished','failed','stopped'))`,
  ).get(sourceRunId, options.exceptRunId ?? 0, options.onlyEnded ? 1 : 0) as { n: number }).n;
}

/** 工单最新的执行 Run 的 id。修复回合、对话和集成都不算执行 Run。 */
export function latestExecutionRunId(db: Db, itemId: number): number | null {
  return latestExecutorExecutionRun(db, itemId)?.id ?? null;
}

export interface RegistrationBlocker {
  code: string;
  title: string;
  summary: string;
}

/** 这个 Run 还挂着的登记相关 blocker，按升起的先后排列。 */
export function registrationBlockers(db: Db, itemId: number, runId: number): RegistrationBlocker[] {
  const rows = db.prepare(
    `SELECT json_extract(payload, '$.blockerCode') AS code,
            json_extract(payload, '$.title') AS title,
            json_extract(payload, '$.summary') AS summary
     FROM inbox
     WHERE item_id=? AND severity='blocker'
       AND json_extract(payload, '$.blockerCode') IN (${REGISTRATION_BLOCKER_CODES.map(() => "?").join(", ")})
       AND json_extract(payload, '$.runId')=?
     ORDER BY id`,
  ).all(itemId, ...REGISTRATION_BLOCKER_CODES, runId) as Array<{ code: string; title: unknown; summary: unknown }>;
  return rows.map((row) => ({
    code: row.code,
    title: typeof row.title === "string" ? row.title : row.code,
    summary: typeof row.summary === "string" ? row.summary : "",
  }));
}

/**
 * 修复回合的闸门。返回拒绝的原因；可以创建时返回 null。
 * 来源 Run 是工单最新的执行 Run。它必须已经 finished，成果还没有登记，修复额度还有剩余。
 * 工单必须停在这个 Run 的登记相关 blocked 上，或者停在 active。
 * 这里不看执行重试额度和宿主缺陷闸门。修复回合有自己的额度，而且它正是为这些情况准备的。
 * 调用方知道修复的是哪个 Run 时，传 sourceRunId。它不是最新的执行 Run 时，请求已经过时。
 */
export function outcomeRepairRefusal(
  db: Db,
  args: {
    itemId: number; role: "executor" | "reviewer"; stage: ItemStage;
    sourceRunId?: number | null; repairRunId?: number;
  },
): string | null {
  if (args.role !== "executor") return `outcome repair run must be an executor run (item #${args.itemId})`;
  const source = latestExecutorExecutionRun(db, args.itemId);
  if (!source) return `outcome repair requires a finished execution run (item #${args.itemId} has none)`;
  if (args.sourceRunId !== undefined && args.sourceRunId !== source.id) {
    return `outcome repair source run #${args.sourceRunId ?? "-"} is not the latest execution run #${source.id} `
      + `of item #${args.itemId}`;
  }
  const state = (db.prepare("SELECT state FROM runs WHERE id=?").get(source.id) as { state: string }).state;
  if (state !== "finished") {
    return `outcome repair requires a finished source run (run #${source.id} is ${state})`;
  }
  if (db.prepare("SELECT 1 FROM outcome_snapshots WHERE executor_run_id=? LIMIT 1").get(source.id)) {
    return `outcome repair is not needed: run #${source.id} already has a registered outcome`;
  }
  // 额度在闸门里，所以额度用完以后，任何一条路径都建不出新的修复回合。
  // 例如 daemon 重启把被打断的修复请求交回队列时，那个请求会被拒绝。
  const limit = outcomeRepairLimit();
  if (outcomeRepairRunsUsed(db, source.id, { onlyEnded: true, exceptRunId: args.repairRunId }) >= limit) {
    return `outcome repair budget of run #${source.id} is used up (${limit} per execution run)`;
  }
  if (args.stage === "active") return null;
  if (args.stage === "blocked" && registrationBlockers(db, args.itemId, source.id).length > 0) return null;
  return `outcome repair requires item #${args.itemId} to be blocked by the registration of run #${source.id}, `
    + `or active (item is ${args.stage})`;
}

export function hostRegistrationHaltMessage(itemId: number, runId: number): string {
  return `工单 #${itemId} 的最近一次执行（Run #${runId}）已结束，但成果登记失败。`
    + "这是同一宿主缺陷，不能再派发。不要换模型或换 runtime 重开一条执行线。"
    + "请先修复成果信封，或由用户明确授权后再试。";
}

export function retryExhaustedMessage(itemId: number, budget: ExecutorRetryBudget): string {
  return `工单 #${itemId} 的执行重试已耗尽（执行失败 ${budget.failures}/${budget.retryLimit}）。`
    + `这条线已经停下，不要再派发：换个模型、换个 runtime、重开一张同名工单，都还是同一件`
    + `失败的事。请把失败原因和证据摆给**用户**，由他决定改方案、放宽 retry_limit、还是取消。`;
}

// sourceRunId、repairRunId：已经建好的修复回合（恢复、认领）要核对它补交的来源 Run 还是不是最新的执行
// （发布评审 run-resume F6）。新建的修复回合由派发路径核对，这里不传。
export function assertRunAllowed(
  db: Db,
  args: {
    itemId: number; role: "executor" | "reviewer"; purpose: RunPurpose;
    sourceRunId?: number | null; repairRunId?: number;
  },
): void {
  const row = db.prepare(
    "SELECT kind, stage, plan_state, root_item_id FROM items WHERE id = ?",
  ).get(args.itemId) as
    { kind: string; stage: string; plan_state: string | null; root_item_id: number | null } | undefined;
  if (!row) throw new Error(`item ${args.itemId} not found`);
  if (row.kind !== "task") {
    throw new Error(`only a task may have a run (item #${args.itemId} is a ${row.kind})`);
  }
  if (args.purpose === "conversation") {
    if (row.stage === "cancelled") {
      throw new Error(`conversation run cannot start on cancelled item #${args.itemId}`);
    }
    return;
  }
  // 代查（slack-takeover spec D5）：一次代查一张自己的工单，Run 和工单在同一笔事务里建好。
  // 它不是交付，所以不过关系闸门、执行重试额度和宿主缺陷闸门；只要求 executor，工单还没开跑或正在跑。
  // 代查只跑一次：进程内的会话结束就没有了，不能恢复、不能重跑。所以这张工单上只能有这一个 Run，
  // 而且它还没开始（建 Run 时一个都没有，runItem 启动时它是 starting）。恢复控制把暂停的 Run 翻成 running 以后再过闸门，
  // 会被这里拒绝，不会用真实的 CLI 去续接一个代查。
  if (args.purpose === "lookup") {
    if (args.role !== "executor") throw new Error(`lookup run must be an executor run (item #${args.itemId})`);
    if (row.stage !== "ready" && row.stage !== "active") {
      throw new Error(`lookup run requires stage 'ready' or 'active' (item #${args.itemId} is ${row.stage})`);
    }
    const runs = db.prepare("SELECT state FROM runs WHERE item_id = ?").all(args.itemId) as Array<{ state: string }>;
    if (runs.length > 1 || (runs.length === 1 && runs[0]!.state !== "starting")) {
      throw new Error(`a lookup item runs its lookup exactly once (item #${args.itemId})`);
    }
    return;
  }
  // 修复回合不是新的工作，它只补交来源 Run 的成果（spec D4）。
  // 所以它不过关系闸门、执行重试额度和宿主缺陷闸门，只看自己的分支。
  if (args.purpose === "outcome_repair") {
    const refusal = outcomeRepairRefusal(db, {
      itemId: args.itemId, role: args.role, stage: row.stage as ItemStage,
      ...(args.sourceRunId === undefined ? {} : { sourceRunId: args.sourceRunId }),
      ...(args.repairRunId === undefined ? {} : { repairRunId: args.repairRunId }),
    });
    if (refusal) throw new Error(refusal);
    return;
  }
  if (args.role === "reviewer") {
    if (row.stage !== "review") {
      throw new Error(
        `reviewer run requires stage 'review' (item #${args.itemId} is ${row.stage})`,
      );
    }
    return;
  }
  assertTicketRelationsAllowRun(db, args.itemId);
  if (args.purpose === "integration") {
    if (row.stage !== "active" || row.plan_state !== "integrating") {
      throw new Error(
        `integration run requires stage 'active' and plan_state 'integrating' `
        + `(item #${args.itemId} is ${row.stage}/${row.plan_state})`,
      );
    }
    return;
  }
  if (!EXECUTOR_STAGES.includes(row.stage)) {
    throw new Error(
      `executor run requires stage in {${EXECUTOR_STAGES.join(", ")}} `
      + `(item #${args.itemId} is ${row.stage})`,
    );
  }
  // 重试预算用尽即停（见上）。放在 stage 检查之后：先说"这个 stage 不能跑"更贴近调用方的错。
  const budget = executorRetryBudget(db, args.itemId);
  if (budget.exhausted) throw new Error(retryExhaustedMessage(args.itemId, budget));
  const hostHalt = hostOutcomeRegistrationHalt(db, args.itemId);
  if (hostHalt) throw new Error(hostRegistrationHaltMessage(args.itemId, hostHalt.runId));
  // 「建完先别跑」是树的属性，不是行的属性：§6.6 说确认发生在树根，所以子任务生于 ready。
  // 只看自己那一行就留了一条路——用户说先别动 → lead hold 住根 → lead 建一批 ready 子任务
  // → spawn_child，用户明确拒绝的工作照样跑起来。闸门必须读到根。
  // 不会卡死编排：child 建的子任务只在 child 正在运行时才存在，那时根必然已经 ready/active。
  if (row.root_item_id !== null && row.root_item_id !== args.itemId) {
    const root = db.prepare("SELECT stage FROM items WHERE id = ?")
      .get(row.root_item_id) as { stage: string } | undefined;
    if (root?.stage === "draft") {
      throw new Error(
        `root item #${row.root_item_id} is still draft; confirm it before running #${args.itemId}`,
      );
    }
  }
}
