import type { Db } from "./db.js";
import { addActivity } from "./activities.js";
import { executorRetryBudget, hostOutcomeRegistrationHalt } from "./run-gate.js";
import { activePairedUserTurn } from "./user-turn-authority.js";

export interface RetryAuthorizationResult {
  itemId: number;
  failures: number;
  previousRetryLimit: number;
  retryLimit: number;
  additionalAttempts: number;
  sourceTurnId: string;
  deduplicated: boolean;
}

export function authorizeExecutorRetry(
  db: Db,
  input: { itemId: number; additionalAttempts: number; sourceTurnId: string | null },
): RetryAuthorizationResult {
  if (!Number.isInteger(input.additionalAttempts) || input.additionalAttempts < 1 || input.additionalAttempts > 5) {
    throw new Error("additional_attempts must be an integer between 1 and 5");
  }
  return db.transaction(() => {
    const item = db.prepare(
      "SELECT id, kind, retry_limit, plan_state, active_plan_revision FROM items WHERE id=?",
    ).get(input.itemId) as {
      id: number;
      kind: string;
      retry_limit: number | null;
      plan_state: string | null;
      active_plan_revision: number | null;
    } | undefined;
    if (!item) throw new Error(`item #${input.itemId} not found`);
    if (item.kind !== "task") throw new Error(`item #${input.itemId} is not a task`);

    const turn = activePairedUserTurn(db, input.sourceTurnId, "retry authorization", "tickets:create");

    const existing = db.prepare(
      `SELECT payload FROM activities
       WHERE item_id=? AND actor='user' AND kind='decision'
         AND json_extract(payload, '$.decision')='retry_authorized'
         AND json_extract(payload, '$.sourceTurnId')=?
       ORDER BY id DESC LIMIT 1`,
    ).get(item.id, turn.id) as { payload: string } | undefined;
    if (existing) {
      const payload = JSON.parse(existing.payload) as {
        failures: number;
        previousRetryLimit: number;
        retryLimit: number;
        additionalAttempts: number;
      };
      return {
        itemId: item.id,
        failures: payload.failures,
        previousRetryLimit: payload.previousRetryLimit,
        retryLimit: payload.retryLimit,
        additionalAttempts: payload.additionalAttempts,
        sourceTurnId: turn.id,
        deduplicated: true,
      };
    }

    const budget = executorRetryBudget(db, item.id);
    const hostHalt = hostOutcomeRegistrationHalt(db, item.id);
    if (!budget.exhausted && !hostHalt) {
      throw new Error(
        `item #${item.id} retry budget is not exhausted (${budget.failures}/${budget.retryLimit}); `
        + "start the existing item without changing its retry limit",
      );
    }
    const nextLimit = budget.exhausted
      ? budget.failures + input.additionalAttempts - 1
      : budget.retryLimit;
    if (budget.exhausted) {
      db.prepare(
        `UPDATE items
         SET retry_limit=?,
             plan_state=CASE
               WHEN plan_state='failed' AND active_plan_revision IS NULL THEN 'none'
               ELSE plan_state
             END,
             updated_at=datetime('now')
         WHERE id=?`,
      ).run(nextLimit, item.id);
    }
    addActivity(db, {
      itemId: item.id,
      actor: "user",
      kind: "decision",
      sessionCursor: turn.id,
      payload: {
        decision: "retry_authorized",
        sourceTurnId: turn.id,
        sourceBindingId: turn.origin_binding_id,
        sourceChannel: turn.origin_kind,
        failures: budget.failures,
        previousRetryLimit: budget.retryLimit,
        retryLimit: nextLimit,
        additionalAttempts: input.additionalAttempts,
        hostRegistrationRetry: hostHalt !== null,
      },
    });
    return {
      itemId: item.id,
      failures: budget.failures,
      previousRetryLimit: budget.retryLimit,
      retryLimit: nextLimit,
      additionalAttempts: input.additionalAttempts,
      sourceTurnId: turn.id,
      deduplicated: false,
    };
  }).immediate();
}

