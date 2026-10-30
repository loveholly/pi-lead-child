// 结构化验收标准的存储规则（spec 5.1、D5、D6，工单 05）。
//   - 一条一行，有稳定的 id、顺序、文字、谁写的、改过的时间、是否已删除。
//   - 文字只有一行：拒绝换行和控制字符，拒绝像密钥的内容，有长度和条数上限。
//   - 改了某一条的文字、或者删了它，你对它的确认作废（按交付存的确认都作废，账本里还在）。
//   - 确认按交付（04 的交付快照：执行 Run 和那一份快照）存。同一次交付的同一条只有一个有效的确认。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  ACCEPTANCE_CRITERIA_LIMITS, AcceptanceCriteriaError, addAcceptanceCriteria, confirmCriterion, createItem, createRun,
  editAcceptanceCriteria, getExecutorCriteriaView, insertOutcomeSnapshot, listAcceptanceCriteria, listCriterionConfirmations,
  listCriterionRevisions, normalizeCriterionTexts, recordExecutorCriteriaView,
  normalizeOutcomePayload, openDb, recordDeliverySnapshot, transition, unconfirmCriterion, updateRun, type Db,
} from "../src/index.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-criteria-"), "plc.db")); });

function task(): number {
  return createItem(db, { title: "修复空输入", brief: "b", createdBy: "lead" });
}

function deliver(itemId: number): { runId: number; snapshotId: number } {
  if (db.prepare("SELECT stage FROM items WHERE id=?").pluck().get(itemId) !== "active") {
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  }
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  insertOutcomeSnapshot(db, {
    itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: runId, sourceOutputSha256: "b".repeat(64),
    outcome: normalizeOutcomePayload({ summary: "做完了", changes: [], deliverables: [], validations: [] }, {}),
    now: new Date(),
  });
  transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
  const { snapshot } = recordDeliverySnapshot(db, {
    itemId, executorRunId: runId, reason: "delivered", source: "agent", baseSha: null, headSha: null,
    commits: [], commitCount: 0, files: [], totals: null, truncated: false, uncommittedFiles: null,
  });
  return { runId, snapshotId: snapshot!.id };
}

function refusal(fn: () => unknown): AcceptanceCriteriaError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AcceptanceCriteriaError);
    return error as AcceptanceCriteriaError;
  }
  throw new Error("expected a refusal");
}

describe("the text of a criterion", () => {
  it("is one trimmed line without control characters or secrets, within the limits", () => {
    expect(normalizeCriterionTexts(["  空输入返回 400  ", "错误信息写明字段名"])).toEqual(["空输入返回 400", "错误信息写明字段名"]);
    expect(normalizeCriterionTexts([])).toEqual([]);
    expect(refusal(() => normalizeCriterionTexts(["第一行\n## 伪造的一节"])).message).toMatch(/one line/);
    expect(refusal(() => normalizeCriterionTexts(["行尾\u2028分隔"])).message).toMatch(/one line/);
    expect(refusal(() => normalizeCriterionTexts(["制表\t符"])).message).toMatch(/control/);
    // 审查 L4：NEL、双向控制字符、零宽字符（显示出来的和存的不一样）。
    expect(refusal(() => normalizeCriterionTexts(["带\u0085换行"])).message).toMatch(/one line/);
    for (const hidden of ["\u202e", "\u2066", "\u200b", "\ufeff", "\u00ad"]) {
      expect(refusal(() => normalizeCriterionTexts([`看起来正常${hidden}的一条`])).message, JSON.stringify(hidden)).toMatch(/control or invisible/);
    }
    expect(refusal(() => normalizeCriterionTexts([""])).message).toMatch(/empty/);
    expect(refusal(() => normalizeCriterionTexts(["   "])).message).toMatch(/empty/);
    expect(refusal(() => normalizeCriterionTexts(["x".repeat(ACCEPTANCE_CRITERIA_LIMITS.textMaxLength + 1)])).message)
      .toMatch(new RegExp(`at most ${ACCEPTANCE_CRITERIA_LIMITS.textMaxLength}`));
    expect(refusal(() => normalizeCriterionTexts(["用 sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA 调接口"])).message)
      .toMatch(/secret/);
    expect(refusal(() => normalizeCriterionTexts(["同一条", "同一条"])).message).toMatch(/duplicate/);
    expect(refusal(() => normalizeCriterionTexts(Array.from({ length: ACCEPTANCE_CRITERIA_LIMITS.maxCriteria + 1 }, (_, i) => `第 ${i} 条`))).message)
      .toMatch(new RegExp(`at most ${ACCEPTANCE_CRITERIA_LIMITS.maxCriteria}`));
    expect(refusal(() => normalizeCriterionTexts("空输入返回 400")).message).toMatch(/array/);
    expect(refusal(() => normalizeCriterionTexts([42])).message).toMatch(/string/);
  });
});

describe("writing criteria", () => {
  it("stores one row per criterion with a stable id, its order and who wrote it", () => {
    const itemId = task();
    const written = addAcceptanceCriteria(db, {
      itemId, texts: ["空输入返回 400", "错误信息写明字段名"], by: "lead", now: new Date("2026-10-22T01:00:00.000Z"),
    });
    expect(written).toMatchObject([
      { itemId, position: 1, text: "空输入返回 400", revision: 1, createdBy: "lead", createdAt: "2026-10-22T01:00:00.000Z", editedAt: null, deletedAt: null },
      { itemId, position: 2, text: "错误信息写明字段名", revision: 1, createdBy: "lead" },
    ]);
    expect(listAcceptanceCriteria(db, itemId)).toEqual(written);
  });

  it("refuses a reminder", () => {
    const reminder = createItem(db, { kind: "reminder", title: "体检", brief: "b", createdBy: "user", remindAt: "2026-11-01T01:00:00.000Z" });
    expect(refusal(() => addAcceptanceCriteria(db, { itemId: reminder, texts: ["x"], by: "lead" })).message).toMatch(/task/);
  });
});

describe("editing criteria", () => {
  it("adds, edits, removes and reorders by id; ids stay stable and an unchanged text is not an edit", () => {
    const itemId = task();
    const [a, b, c] = addAcceptanceCriteria(db, { itemId, texts: ["甲", "乙", "丙"], by: "lead" });
    const result = editAcceptanceCriteria(db, {
      itemId, by: "user", now: new Date("2026-10-22T02:00:00.000Z"),
      update: [{ id: a!.id, text: "甲（改）" }, { id: c!.id, text: "丙" }],
      remove: [{ id: b!.id }],
      order: [c!.id, a!.id],
      add: ["丁"],
    });
    expect(result).toMatchObject({
      changed: true, edited: [{ id: a!.id, from: "甲", to: "甲（改）" }], removed: [{ id: b!.id, text: "乙" }], reordered: true, voided: [],
    });
    expect(result.added).toHaveLength(1);
    expect(listAcceptanceCriteria(db, itemId).map((row) => [row.id, row.position, row.text, row.revision])).toEqual([
      [c!.id, 1, "丙", 1], [a!.id, 2, "甲（改）", 2], [result.added[0], 3, "丁", 1],
    ]);
    const edited = listAcceptanceCriteria(db, itemId).find((row) => row.id === a!.id)!;
    expect(edited).toMatchObject({ createdBy: "lead", editedBy: "user", editedAt: "2026-10-22T02:00:00.000Z" });
    expect(listAcceptanceCriteria(db, itemId, { includeDeleted: true }).find((row) => row.id === b!.id))
      .toMatchObject({ deletedBy: "user", deletedAt: "2026-10-22T02:00:00.000Z" });
    // 每一版文字都留着（审查 M4）。
    expect(listCriterionRevisions(db, a!.id).map((row) => [row.revision, row.text, row.writtenBy])).toEqual([
      [1, "甲", "lead"], [2, "甲（改）", "user"],
    ]);
    expect(listCriterionRevisions(db, result.added[0]!).map((row) => [row.revision, row.text])).toEqual([[1, "丁"]]);

    // 什么都没变：不记新的一版。
    expect(editAcceptanceCriteria(db, { itemId, by: "lead", update: [{ id: c!.id, text: "丙" }] }))
      .toMatchObject({ changed: false, edited: [], added: [], removed: [], reordered: false });
  });

  it("refuses ids of another ticket, conflicting operations and duplicates", () => {
    const itemId = task();
    const other = task();
    const [a, b] = addAcceptanceCriteria(db, { itemId, texts: ["甲", "乙"], by: "lead" });
    const [foreign] = addAcceptanceCriteria(db, { itemId: other, texts: ["别的"], by: "lead" });
    expect(refusal(() => editAcceptanceCriteria(db, { itemId, by: "lead" })).code).toBe("invalid_input");
    expect(refusal(() => editAcceptanceCriteria(db, { itemId, by: "lead", update: [{ id: foreign!.id, text: "x" }] })))
      .toMatchObject({ code: "not_found" });
    expect(refusal(() => editAcceptanceCriteria(db, { itemId, by: "lead", update: [{ id: a!.id, text: "x" }], remove: [{ id: a!.id }] })).message)
      .toMatch(/both/);
    expect(refusal(() => editAcceptanceCriteria(db, { itemId, by: "lead", add: ["乙"] })).message).toMatch(/duplicate/);
    editAcceptanceCriteria(db, { itemId, by: "lead", remove: [{ id: b!.id }] });
    expect(refusal(() => editAcceptanceCriteria(db, {
      itemId, by: "lead", add: Array.from({ length: ACCEPTANCE_CRITERIA_LIMITS.maxCriteria }, (_, i) => `新的 ${i}`),
    })).message).toMatch(new RegExp(`at most ${ACCEPTANCE_CRITERIA_LIMITS.maxCriteria}`));
    // 被拒时什么都没写。
    expect(listAcceptanceCriteria(db, itemId).map((row) => row.text)).toEqual(["甲"]);
  });

  // 审查 M3：两个人基于同一个旧页面改。给了页面看到的 revision 时，后到的那一个被拒（stale），不悄悄覆盖。
  // 已经被删掉的、order 对不上的，也是页面过时了，不是输入不对。
  it("refuses an edit made on a stale page", () => {
    const itemId = task();
    const [a, b] = addAcceptanceCriteria(db, { itemId, texts: ["原文", "乙"], by: "lead" });
    editAcceptanceCriteria(db, { itemId, by: "lead", update: [{ id: a!.id, text: "Lead 的版本", revision: 1 }] });
    const late = refusal(() => editAcceptanceCriteria(db, { itemId, by: "user", update: [{ id: a!.id, text: "用户的版本", revision: 1 }] }));
    expect(late).toMatchObject({ code: "stale" });
    expect(late.message).toMatch(/revision 2/);
    expect(refusal(() => editAcceptanceCriteria(db, { itemId, by: "user", remove: [{ id: a!.id, revision: 1 }] })).code).toBe("stale");
    expect(refusal(() => editAcceptanceCriteria(db, { itemId, by: "user", order: [a!.id] })).code).toBe("stale");
    editAcceptanceCriteria(db, { itemId, by: "lead", remove: [{ id: b!.id }] });
    expect(refusal(() => editAcceptanceCriteria(db, { itemId, by: "user", remove: [{ id: b!.id }] })).code).toBe("stale");
    expect(refusal(() => editAcceptanceCriteria(db, { itemId, by: "user", update: [{ id: b!.id, text: "x" }] })).code).toBe("stale");
    expect(listAcceptanceCriteria(db, itemId).map((row) => [row.text, row.revision])).toEqual([["Lead 的版本", 2]]);
    // 带着现在的 revision 就能改。
    editAcceptanceCriteria(db, { itemId, by: "user", update: [{ id: a!.id, text: "用户的版本", revision: 2 }] });
    expect(listAcceptanceCriteria(db, itemId).map((row) => [row.text, row.revision])).toEqual([["用户的版本", 3]]);
  });
});

describe("what the executor saw", () => {
  it("keeps the criteria and revisions of the executor's latest start", () => {
    const itemId = task();
    const [a] = addAcceptanceCriteria(db, { itemId, texts: ["甲"], by: "lead" });
    const runId = createRun(db, { itemId });
    expect(getExecutorCriteriaView(db, runId)).toBeUndefined();
    recordExecutorCriteriaView(db, { itemId, runId, criteria: [], now: new Date("2026-10-22T01:00:00.000Z") });
    recordExecutorCriteriaView(db, { itemId, runId, criteria: [{ id: a!.id, revision: 1 }], now: new Date("2026-10-22T01:05:00.000Z") });
    expect(getExecutorCriteriaView(db, runId)).toEqual({
      runId, itemId, criteria: [{ id: a!.id, revision: 1 }], seenAt: "2026-10-22T01:05:00.000Z",
    });
  });
});

describe("confirmations", () => {
  it("are stored per delivery: the second delivery starts with none", () => {
    const itemId = task();
    const [a, b] = addAcceptanceCriteria(db, { itemId, texts: ["甲", "乙"], by: "lead" });
    const first = deliver(itemId);
    confirmCriterion(db, { itemId, criterionId: a!.id, executorRunId: first.runId, deliverySnapshotId: first.snapshotId, by: "user" });
    confirmCriterion(db, {
      itemId, criterionId: b!.id, executorRunId: first.runId, deliverySnapshotId: first.snapshotId,
      by: "lead", onBehalfOf: { sourceTurnId: "turn-1" },
    });
    // 再确认一次：不另记一条。
    expect(confirmCriterion(db, { itemId, criterionId: a!.id, executorRunId: first.runId, deliverySnapshotId: first.snapshotId, by: "user" }))
      .toMatchObject({ changed: false });

    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    const second = deliver(itemId);
    expect(listCriterionConfirmations(db, { itemId, executorRunId: second.runId })).toEqual([]);
    expect(listCriterionConfirmations(db, { itemId, executorRunId: first.runId })).toMatchObject([
      { criterionId: a!.id, confirmedBy: "user", onBehalfOf: null, sourceTurnId: null, endedAt: null },
      { criterionId: b!.id, confirmedBy: "lead", onBehalfOf: "user", sourceTurnId: "turn-1", endedAt: null },
    ]);
  });

  it("can be withdrawn, and the withdrawal stays in the history", () => {
    const itemId = task();
    const [a] = addAcceptanceCriteria(db, { itemId, texts: ["甲"], by: "lead" });
    const delivery = deliver(itemId);
    confirmCriterion(db, { itemId, criterionId: a!.id, executorRunId: delivery.runId, deliverySnapshotId: delivery.snapshotId, by: "user" });
    expect(unconfirmCriterion(db, { itemId, criterionId: a!.id, executorRunId: delivery.runId, by: "user" })).toMatchObject({ changed: true });
    expect(unconfirmCriterion(db, { itemId, criterionId: a!.id, executorRunId: delivery.runId, by: "user" })).toMatchObject({ changed: false });
    expect(listCriterionConfirmations(db, { itemId, executorRunId: delivery.runId }))
      .toMatchObject([{ criterionId: a!.id, endedBy: "user", endReason: "unconfirmed" }]);
    // 取消以后可以再确认。
    expect(confirmCriterion(db, { itemId, criterionId: a!.id, executorRunId: delivery.runId, deliverySnapshotId: delivery.snapshotId, by: "user" }))
      .toMatchObject({ changed: true });
  });

  it("are voided when the criterion is edited or deleted after the delivery; other criteria keep theirs", () => {
    const itemId = task();
    const [a, b, c] = addAcceptanceCriteria(db, { itemId, texts: ["甲", "乙", "丙"], by: "lead" });
    const delivery = deliver(itemId);
    for (const criterion of [a!, b!, c!]) {
      confirmCriterion(db, { itemId, criterionId: criterion.id, executorRunId: delivery.runId, deliverySnapshotId: delivery.snapshotId, by: "user" });
    }
    const result = editAcceptanceCriteria(db, {
      itemId, by: "lead", now: new Date("2026-10-22T03:00:00.000Z"), update: [{ id: a!.id, text: "甲（改）" }], remove: [{ id: b!.id }],
    });
    expect(result.voided).toHaveLength(2);
    expect(listCriterionConfirmations(db, { itemId, executorRunId: delivery.runId }).map((row) => [row.criterionId, row.endReason, row.endedBy]))
      .toEqual([[a!.id, "criterion_edited", "lead"], [b!.id, "criterion_deleted", "lead"], [c!.id, null, null]]);
    // 改过的那一条可以按新的文字再确认，记下的是新的版本。
    const again = confirmCriterion(db, {
      itemId, criterionId: a!.id, executorRunId: delivery.runId, deliverySnapshotId: delivery.snapshotId, by: "user",
    });
    expect(again.confirmation).toMatchObject({ criterionRevision: 2, endedAt: null });
  });

  // 审查 M4：切回第 1 次交付时，条数和确认要和当时一样。改标准只作废最新一次交付上的确认。
  it("are voided only on the latest delivery; earlier deliveries keep theirs", () => {
    const itemId = task();
    const [a, b] = addAcceptanceCriteria(db, { itemId, texts: ["甲", "乙"], by: "lead" });
    const first = deliver(itemId);
    for (const criterion of [a!, b!]) {
      confirmCriterion(db, { itemId, criterionId: criterion.id, executorRunId: first.runId, deliverySnapshotId: first.snapshotId, by: "user" });
    }
    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    const second = deliver(itemId);
    confirmCriterion(db, { itemId, criterionId: a!.id, executorRunId: second.runId, deliverySnapshotId: second.snapshotId, by: "user" });
    const result = editAcceptanceCriteria(db, { itemId, by: "lead", update: [{ id: a!.id, text: "甲（改）" }], remove: [{ id: b!.id }] });
    expect(result.voided).toHaveLength(1);
    expect(listCriterionConfirmations(db, { itemId, executorRunId: first.runId }).map((row) => [row.criterionId, row.endedAt]))
      .toEqual([[a!.id, null], [b!.id, null]]);
    expect(listCriterionConfirmations(db, { itemId, executorRunId: second.runId }).map((row) => [row.criterionId, row.endReason]))
      .toEqual([[a!.id, "criterion_edited"]]);
  });

  it("refuses a deleted criterion and a snapshot of another delivery", () => {
    const itemId = task();
    const [a, b] = addAcceptanceCriteria(db, { itemId, texts: ["甲", "乙"], by: "lead" });
    const first = deliver(itemId);
    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    const second = deliver(itemId);
    expect(refusal(() => confirmCriterion(db, {
      itemId, criterionId: a!.id, executorRunId: second.runId, deliverySnapshotId: first.snapshotId, by: "user",
    })).message).toMatch(/snapshot/);
    editAcceptanceCriteria(db, { itemId, by: "user", remove: [{ id: b!.id }] });
    // 页面上还显示着这一条：页面过时了（审查 M3）。
    expect(refusal(() => confirmCriterion(db, {
      itemId, criterionId: b!.id, executorRunId: second.runId, deliverySnapshotId: second.snapshotId, by: "user",
    })).code).toBe("stale");
  });
});
