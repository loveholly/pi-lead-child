// ── 交付 Run：哪些 executor Run 代表"这张工单交出了一份新成果" ─────────────────
//
// 工单 #66 上，Run #50/#51 是用户在工单里提的两个问题（purpose=conversation）。好几处代码用
// `MAX(id) WHERE role='executor'` 找"最新的执行"，于是把一次回答当成了一次交付：成果恢复
// 说它"交不出成果"，核查投影说工单"卡死"，而真正的最后一次交付 Run #49 已经登记了成果快照。
//
// 规则（全仓只此一份，SQL 与 TypeScript 两种写法必须同义）：
//   · conversation 不是交付。它回答用户，ingest 的 settle 不让它改生命周期，
//     它的启动 checkpoint 也写着 "without changing the task lifecycle"。
//   · outcome_repair 不是交付。它只补交来源 Run 的成果，成果登记在来源 Run 上，
//     来源 Run 仍然是最新的交付；它也不能让来源 Run 之前的核查结论过期。
//   · lookup 不是交付。代查（slack-takeover spec D5）的结果交给通道 hub，不登记成果，也不进 review 等人验收。
//   · 其余 executor 用途都是交付：execution 是普通执行，integration 是父工单的交付，
//     learning 产出 SKILL.md 和 evaluator 并走自动核查。
//   · 没启动成的 Run（error_code=run_start_refused）不是交付，用途是什么都一样：它没有开始，没有交出任何东西
//     （发布评审 reliability-backlog 复核）。
// 这里刻意不写成"只认 execution"：那会让父工单的集成和 learning 工单的交付对核查不可见。
//
// 规则放在 store 层，是因为数据迁移（data-corrections.ts）也要用它；engine 从这里转出。
import type { Db } from "./db.js";
import type { Run, RunPurpose } from "@pi-lead-child/core";

export const NON_DELIVERY_RUN_PURPOSES = ["conversation", "outcome_repair", "lookup"] as const satisfies readonly RunPurpose[];

const REFUSED_START_ERROR_CODE = "run_start_refused";

/** runs 表上"交付 Run"的 SQL 条件。alias 是 runs 的别名。 */
export function deliveryRunSql(alias: string): string {
  return `(${alias}.role = 'executor' AND ${alias}.purpose NOT IN (${
    NON_DELIVERY_RUN_PURPOSES.map((purpose) => `'${purpose}'`).join(", ")
  }) AND ${alias}.error_code IS NOT '${REFUSED_START_ERROR_CODE}')`;
}

// error_code 可以不给：还没开始的 Run（例如启动时判断）没有错误码。
export function isDeliveryRun(run: Pick<Run, "role" | "purpose"> & { error_code?: string | null }): boolean {
  return run.role === "executor"
    && !(NON_DELIVERY_RUN_PURPOSES as readonly RunPurpose[]).includes(run.purpose)
    && run.error_code !== REFUSED_START_ERROR_CODE;
}

/** 工单最新的交付 Run；没有时为 null。 */
export function latestDeliveryRunId(db: Db, itemId: number): number | null {
  return (db.prepare(
    `SELECT MAX(r.id) AS run_id FROM runs r WHERE r.item_id=? AND ${deliveryRunSql("r")}`,
  ).get(itemId) as { run_id: number | null }).run_id;
}

/** 某个 Run（例如一次 reviewer）之前最近的那次交付：那个 reviewer 核查的就是它。 */
export function deliveryRunBefore(db: Db, itemId: number, runId: number): number | null {
  return (db.prepare(
    `SELECT MAX(r.id) AS run_id FROM runs r WHERE r.item_id=? AND r.id < ? AND ${deliveryRunSql("r")}`,
  ).get(itemId, runId) as { run_id: number | null }).run_id;
}
