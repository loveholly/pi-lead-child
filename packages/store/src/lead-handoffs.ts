// Lead 交接给轻子 agent 的工单（lead-scheduler spec H3、H6）：交接包的编号、从哪个单元、哪个入口、原来的车道。
// 和 light_task 一样记成一条活动（不改 items 的列）：工单的「经过」里看得到它是交接出来的，Run 结束时
// daemon 的 run-finished.ts 据此把结果按原来的车道交回 Lead（用户的请求交出去，结果回来也是 L0），并带上外部标记。
import { addActivity } from "./activities.js";
import type { Db } from "./db.js";

export const LEAD_HANDOFF_DECISION = "lead_handoff";

export interface ItemHandoff {
  packageId: string;
  unitId: string;
  // lead_initial、lead_midway、forced、suspended。
  entry: string;
  // 原来的车道（0–4）。
  lane: number;
  turnId: string | null;
  // 交接包里有外部内容（routing D10）：子 agent 的结果交回时也算外部。
  external: boolean;
  // 交接包里步骤的个数、已经提交的写操作的个数（工单的「经过」里看得到）。
  steps: number;
  committed: number;
}

export function recordItemHandoff(db: Db, itemId: number, handoff: ItemHandoff): void {
  addActivity(db, { itemId, actor: "lead", kind: "decision", payload: { decision: LEAD_HANDOFF_DECISION, ...handoff } });
}

/** 这张工单是不是交接出来的；是时返回交接的记录。 */
export function itemHandoff(db: Db, itemId: number): ItemHandoff | null {
  const row = db.prepare(
    `SELECT payload FROM activities WHERE item_id = ? AND kind = 'decision' AND json_extract(payload, '$.decision') = ?
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId, LEAD_HANDOFF_DECISION) as { payload: string } | undefined;
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload) as Partial<ItemHandoff>;
    if (typeof payload.packageId !== "string" || typeof payload.unitId !== "string" || typeof payload.lane !== "number") return null;
    return {
      packageId: payload.packageId, unitId: payload.unitId, entry: String(payload.entry ?? "lead_midway"), lane: payload.lane,
      turnId: typeof payload.turnId === "string" ? payload.turnId : null, external: payload.external === true,
      steps: Number(payload.steps ?? 0), committed: Number(payload.committed ?? 0),
    };
  } catch {
    return null;
  }
}
