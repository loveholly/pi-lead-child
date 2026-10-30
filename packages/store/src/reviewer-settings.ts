// 核查员设置（工单详情与验收 spec 5.6、D3，工单 09）：这张工单由谁核查。表在 schema.ts 的 REVIEWER_SETTINGS_SCHEMA（v56）。
//
// - 谁写：Lead 建单时一起选执行者和核查员（create_task 的 reviewer）；之后 Lead 或用户换核查员（engine 的 change-reviewer.ts）。
//   换模型和推理强度（工单 08）也写这里。读写只走下面两个函数。
// - 没有这一行：核查员由系统选（engine 的 reviewer-choice.ts 的 itemReviewer），优先选和执行者不同的 runtime。
// - 这一行是「选了谁」，不是「这次派了谁」：选中的不能用时，派发认领时自动换人，这里不改（故障恢复以后下一次核查还用它）。
// - 模型和推理强度属于 runtime：换了 runtime 而没有给新的，就清空。是否在模型目录里，由调用方核对（Lead 的 assertModelChoice）。
import type { RuntimeId } from "@pi-lead-child/core";
import { isRuntimeId } from "@pi-lead-child/runtime";
import type { Db } from "./db.js";

export type ReviewerChooser = "user" | "lead";

export interface ReviewerSetting {
  itemId: number;
  runtime: RuntimeId;
  model: string | null;
  effort: string | null;
  chosenBy: ReviewerChooser;
  // 为什么选它，例如「brief 里写着严禁调用 codex」。没写时为 null。
  reason: string | null;
  updatedAt: string;
}

export interface ReviewerSettingInput {
  runtime: RuntimeId;
  model?: string | null;
  effort?: string | null;
  chosenBy: ReviewerChooser;
  reason?: string | null;
  now?: Date;
}

interface ReviewerSettingRow {
  item_id: number;
  runtime: string;
  model: string | null;
  effort: string | null;
  chosen_by: ReviewerChooser;
  reason: string | null;
  updated_at: string;
}

const trimmed = (value: string | null | undefined): string | null => value?.trim() || null;

/** 这张工单选好的核查员；没人选过时为 null。库里的 runtime 已经不是登记的 runtime 时也当作没选。 */
export function getReviewerSetting(db: Db, itemId: number): ReviewerSetting | null {
  const row = db.prepare("SELECT * FROM item_reviewer_settings WHERE item_id=?").get(itemId) as ReviewerSettingRow | undefined;
  if (!row || !isRuntimeId(row.runtime)) return null;
  return {
    itemId: row.item_id,
    runtime: row.runtime,
    model: row.model,
    effort: row.effort,
    chosenBy: row.chosen_by,
    reason: row.reason,
    updatedAt: row.updated_at,
  };
}

/** 写下（或整行换掉）这张工单的核查员。只能给 task（触发器）。返回写下的设置。 */
export function setReviewerSetting(db: Db, itemId: number, input: ReviewerSettingInput): ReviewerSetting {
  if (!isRuntimeId(input.runtime)) throw new Error(`setReviewerSetting: unknown runtime ${String(input.runtime).slice(0, 40)}`);
  db.prepare(
    `INSERT INTO item_reviewer_settings (item_id, runtime, model, effort, chosen_by, reason, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       runtime=excluded.runtime, model=excluded.model, effort=excluded.effort,
       chosen_by=excluded.chosen_by, reason=excluded.reason, updated_at=excluded.updated_at`,
  ).run(
    itemId, input.runtime, trimmed(input.model), trimmed(input.effort), input.chosenBy, trimmed(input.reason),
    (input.now ?? new Date()).toISOString(),
  );
  return getReviewerSetting(db, itemId)!;
}
