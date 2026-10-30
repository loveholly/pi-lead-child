// 一个 Run 用哪个模型、哪个推理强度（effort）。2026-10-15 以前，每个启动路径各写一遍
// `explicit ?? items.requested_model ?? defaultRuntimeModel(runtime)`，有两个问题：
//   - items.requested_model 是给执行 runtime 的。核查、工单对话也拿它，reviewer 的 runtime 不一定认得；
//   - defaultRuntimeModel 写死 gpt-5.5。账号不支持以后，工单 #66 的核查连续失败 7 次（Run #73–#79）。
// 现在所有启动路径都走这里的同一条规则。
import type { Item, Run, RuntimeId } from "@pi-lead-child/core";
import type { Db } from "@pi-lead-child/store";
import { defaultRuntimeModel, resolveRuntimeModel } from "@pi-lead-child/runtime";

export interface RunModelInput {
  /** 这次明确选的模型：Lead、用户、恢复或派发请求给的。 */
  explicit?: string | null;
  role: "executor" | "reviewer";
  runtime: RuntimeId;
  item: Pick<Item, "requested_runtime" | "requested_model">;
  /** 续接的 session 所在的 Run。在同一个 runtime 上续接时，沿用它的模型（比 choice 早的除外）。 */
  resumedFrom?: (Pick<Run, "runtime" | "model"> & { id?: number }) | null;
  /**
   * 这张工单的核查员（工单 09）：只给核查 Run，并且 runtime 要和它一致。派发认领、直接启动用 reviewer-choice.ts 的
   * reviewerProfileFor（按能不能用换过的）；排核查请求时用工单选好的那一行（store 的 getReviewerSetting），不能用时由认领时换。
   */
  reviewer?: RunReviewerProfile | null;
  /** 执行者最近一次换的模型和强度（runProfileChoice）。续接的 session 比它早时，不沿用 session 原来的模型。 */
  choice?: RunProfileChoice | null;
}

/**
 * 这张工单最近一次给执行者换模型和推理强度（工单 08 的 set_run_profile）：在哪个 runtime 上，换的时候工单上最新的 Run。
 * 新的模型写在工单的 requested_model 上，强度写在 execution_profile_selected 里。比它早的 Run（续接的 session、
 * 同类的上一个 Run）不能盖过它；比它晚的 Run 是之后又有人明确选过（例如 recover_ticket_run 换了模型），照常沿用。
 */
export interface RunProfileChoice {
  runtime: RuntimeId;
  afterRunId: number;
}

export function runProfileChoice(db: Db, itemId: number, role: "executor" | "reviewer"): RunProfileChoice | null {
  if (role !== "executor") return null;
  const row = db.prepare(
    `SELECT json_extract(payload, '$.runtime') AS runtime, json_extract(payload, '$.afterRunId') AS afterRunId FROM activities
     WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')='execution_profile_selected'
       AND json_extract(payload, '$.role')=? AND json_extract(payload, '$.afterRunId') IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId, role) as { runtime: RuntimeId; afterRunId: number } | undefined;
  return row ? { runtime: row.runtime, afterRunId: Number(row.afterRunId) } : null;
}

// 这个 Run 早于这次换模型：它的模型和强度是换之前的。
function olderThanChoice(choice: RunProfileChoice | null | undefined, runtime: RuntimeId, run: { id?: number }): boolean {
  return Boolean(choice) && choice!.runtime === runtime && run.id !== undefined && run.id <= choice!.afterRunId;
}

/** 核查员的 runtime、模型和推理强度。null 的模型或强度表示没选。 */
export interface RunReviewerProfile {
  runtime: RuntimeId;
  model: string | null;
  effort: string | null;
}

/**
 * 模型的优先顺序：明确的选择；核查 Run 用工单核查员设置里的模型（runtime 一致时）；同一 runtime 上续接的 session 原来的模型
 * （执行者在那个 Run 之后换过模型时除外）；工单给执行者的模型（只给执行 Run，并且 runtime 要和工单要求的一致）；
 * PLC_<RUNTIME>_MODEL 这类显式配置；都没有就不传，由 CLI 自己的配置决定。
 */
export function runModelFor(input: RunModelInput): string | undefined {
  const explicit = input.explicit?.trim();
  const reviewerModel = input.role === "reviewer" && input.reviewer?.runtime === input.runtime ? input.reviewer.model : null;
  const resumed = input.resumedFrom && input.resumedFrom.runtime === input.runtime
    && !(input.role === "executor" && olderThanChoice(input.choice, input.runtime, input.resumedFrom))
    ? input.resumedFrom.model : null;
  const itemModel = input.role === "executor"
    && (!input.item.requested_runtime || input.item.requested_runtime === input.runtime)
    ? input.item.requested_model
    : null;
  const chosen = explicit || reviewerModel || resumed || itemModel || defaultRuntimeModel(input.runtime);
  return resolveRuntimeModel(input.runtime, chosen ?? null);
}

export interface RunEffortInput {
  explicit?: string | null;
  itemId: number;
  role: "executor" | "reviewer";
  purpose: string;
  runtime: RuntimeId;
  model: string | null | undefined;
  resumedFrom?: (Pick<Run, "runtime" | "effort"> & { id?: number }) | null;
  /** 同 RunModelInput.reviewer：核查 Run 在 runtime 一致时用它的推理强度。 */
  reviewer?: RunReviewerProfile | null;
}

/**
 * effort 的优先顺序：明确的选择；核查 Run 用工单核查员设置里的 effort（runtime 和模型都一致时，审查 L7）；同一 runtime 上续接的
 * session 原来的 effort；这张工单上同一角色、同一用途、同一 runtime 和模型的上一个 Run 的 effort（返工、重试和续作沿用 Lead 当初的
 * 选择）；Lead 建单时、或者之后换模型时（set_run_profile）为这个角色和 runtime 选的 effort；都没有就不传。
 * 执行者换过模型和强度以后（runProfileChoice），比那次早的 Run 不再算：续接的 session 和上一个 Run 都用换之前的强度。
 */
export function runEffortFor(db: Db, input: RunEffortInput): string | undefined {
  const explicit = input.explicit?.trim();
  if (explicit) return explicit;
  // 设置里的强度是给设置里的模型选的。这次的模型不一样（例如设置是 opus/max，这次点名 sonnet）时不用它（审查 L7）。
  const reviewer = input.role === "reviewer" && input.reviewer?.runtime === input.runtime ? input.reviewer : null;
  if (reviewer?.effort && sameModel(input.runtime, reviewer.model, input.model)) return reviewer.effort;
  const choice = runProfileChoice(db, input.itemId, input.role);
  if (input.resumedFrom && input.resumedFrom.runtime === input.runtime && input.resumedFrom.effort
    && !olderThanChoice(choice, input.runtime, input.resumedFrom)) {
    return input.resumedFrom.effort;
  }
  const previous = db.prepare(
    `SELECT effort FROM runs
     WHERE item_id=? AND role=? AND purpose=? AND runtime=? AND COALESCE(model, '')=COALESCE(?, '') AND effort IS NOT NULL
       AND id > ?
     ORDER BY id DESC LIMIT 1`,
  ).get(
    input.itemId, input.role, input.purpose, input.runtime, input.model ?? null,
    choice?.runtime === input.runtime ? choice.afterRunId : 0,
  ) as { effort: string } | undefined;
  if (previous?.effort) return previous.effort;
  // Lead 建单时选的 effort（create_task 记下的 execution_profile_selected），或者之后换的（set_run_profile 也记这一条）。
  // items 没有 effort 列，见 schema.ts。它也是给那一条里的模型选的：模型不一样时不用（审查 L7，核查员的设置也记了这一条）。
  const selected = db.prepare(
    `SELECT payload FROM activities
     WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')='execution_profile_selected'
       AND json_extract(payload, '$.role')=? AND json_extract(payload, '$.runtime')=?
     ORDER BY id DESC LIMIT 1`,
  ).get(input.itemId, input.role, input.runtime) as { payload: string } | undefined;
  if (!selected) return undefined;
  try {
    const { effort, model } = JSON.parse(selected.payload) as { effort?: unknown; model?: unknown };
    if (typeof effort !== "string" || !effort) return undefined;
    return sameModel(input.runtime, typeof model === "string" && model ? model : null, input.model) ? effort : undefined;
  } catch {
    return undefined;
  }
}

// 设置里的模型（没选时是这个 runtime 的默认模型）和这次 Run 的模型是不是同一个。两边都按 adapter 换成 CLI 的名字再比。
function sameModel(runtime: RuntimeId, chosen: string | null, model: string | null | undefined): boolean {
  const expected = chosen ?? defaultRuntimeModel(runtime) ?? null;
  let resolved: string | null;
  try {
    resolved = resolveRuntimeModel(runtime, expected) ?? null;
  } catch {
    resolved = expected;
  }
  return resolved === (model ?? null);
}
