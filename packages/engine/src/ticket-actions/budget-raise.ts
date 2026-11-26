// Lead raises a ticket's token budget on its own (ticket #562, protocol ticket-budget.ts).
// User 2026-11-26: "a few million more, decide it yourself and raise it, do not ask me again".
//   - leadBudgetRaiseBlocker decides if this set_budget input is a raise that Lead may make in any turn:
//     only the token budget, from a set budget, up by at most 50% of it. Anything else still needs the user's own turn.
//   - reportLeadBudgetRaise writes the ticket_budget.changed event, so "Lead 动态" shows the raise with an undo button.
//   - undoLeadBudgetRaise puts the budget back (operation budget_raise / <activity id> / undo, ui-actions/budget-raise.ts).
import type { Item } from "@pi-lead-child/core";
import {
  LEAD_BUDGET_RAISE_MAX_RATIO, TICKET_BUDGET_CHANGED_KIND, redactSecretText, ticketBudgetEntityKey,
  type TicketActionInputs, type TicketBudgetChangedPayload,
} from "@pi-lead-child/protocol";
import {
  addActivity, appendEvent, getItem, getLocale, itemUpdatedEvent, leadDisplayName, publishGatewayEvent, setEventDisposition, type Db,
} from "@pi-lead-child/store";
import { budgetMessages } from "./budget.messages.js";

// The triage basis of the event: a hard rule that standing orders cannot change.
export const LEAD_BUDGET_RAISE_REPORTED = "lead_budget_raise_reported";

type BudgetInput = TicketActionInputs["set_budget"];

/** The largest token budget that Lead may set on its own from this budget. Null when there is no budget to raise. */
export function leadBudgetRaiseCeiling(current: number | null): number | null {
  if (current === null || current <= 0) return null;
  return current + Math.floor(current * LEAD_BUDGET_RAISE_MAX_RATIO);
}

/**
 * Null when Lead may make this budget change on its own in any turn: it raises only the token budget, by at most 50% of it.
 * Otherwise one sentence (no full stop) that says why it still needs the user's own turn.
 */
export function leadBudgetRaiseBlocker(item: Pick<Item, "token_budget" | "cost_budget_usd">, input: unknown): string | null {
  const m = budgetMessages("zh");
  const given = (input ?? {}) as Partial<BudgetInput>;
  if (given.costBudgetUsd !== undefined && given.costBudgetUsd !== item.cost_budget_usd) return m.blockUsd;
  const to = given.tokenBudget;
  if (to === undefined || to === null) return m.blockClear;
  const ceiling = leadBudgetRaiseCeiling(item.token_budget);
  if (ceiling === null) return m.blockNoBudget;
  if (to <= item.token_budget!) return m.blockLower;
  if (to > ceiling) return m.blockTooMuch(item.token_budget!, ceiling);
  return null;
}

function reportBudgetChange(db: Db, payload: TicketBudgetChangedPayload, now: Date): number {
  const { event } = appendEvent(db, {
    source: payload.actor === "lead" ? "lead" : "system",
    sourceRef: `activity:${payload.action === "raised" ? payload.activityId : `${payload.undoOf}:undo`}`,
    kind: TICKET_BUDGET_CHANGED_KIND,
    entityKey: ticketBudgetEntityKey(payload.ticketId),
    occurredAt: now.toISOString(),
    level: "digest",
    payload: payload as unknown as Record<string, unknown>,
  }, { basis: { order: null, hardRules: [LEAD_BUDGET_RAISE_REPORTED] }, receivedAt: now });
  // Lead made the raise itself, so the next situation does not need to tell it again (daemon lead-input skips it).
  // An undo by the user goes to Lead: it learns that the user did not want this raise.
  if (payload.actor === "lead") setEventDisposition(db, event.seq, "seen", null, now);
  return event.seq;
}

/** Lead raised the token budget on its own: write ticket_budget.changed (the caller is in the write transaction). */
export function reportLeadBudgetRaise(
  db: Db, raise: { ticketId: number; activityId: number; from: number; to: number; reason: string }, now = new Date(),
): number {
  const m = budgetMessages(getLocale(db));
  const summary = m.raised(leadDisplayName(db), raise.ticketId, raise.from, raise.to, raise.reason.trim());
  return reportBudgetChange(db, {
    ticketId: raise.ticketId, activityId: raise.activityId, action: "raised", actor: "lead", undoOf: null,
    fromTokens: raise.from, toTokens: raise.to, reason: redactSecretText(raise.reason), summary: redactSecretText(summary),
  }, now);
}

// ── One raise, and its undo ─────────────────────────────────────────────────────────

export interface LeadBudgetRaise {
  activityId: number;
  ticketId: number;
  from: number;
  to: number;
  reason: string;
  at: string;
  // The ledger row of the undo. Null when nobody undid it.
  undoneBy: number | null;
}

interface ActivityRow { id: number; item_id: number; payload: string; created_at: string }

/** The raise that Lead made on its own with this ledger row. Null for any other row. */
export function getLeadBudgetRaise(db: Db, activityId: number): LeadBudgetRaise | null {
  const row = db.prepare("SELECT id, item_id, payload, created_at FROM activities WHERE id = ? AND kind = 'decision' AND actor = 'lead'")
    .get(activityId) as ActivityRow | undefined;
  if (!row) return null;
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  if (payload.decision !== "budget_changed" || payload.leadOwnRaise !== true) return null;
  const from = (payload.from as { tokenBudget?: unknown } | undefined)?.tokenBudget;
  const to = (payload.to as { tokenBudget?: unknown } | undefined)?.tokenBudget;
  if (typeof from !== "number" || typeof to !== "number") return null;
  const undo = db.prepare(
    `SELECT id FROM activities WHERE item_id = ? AND kind = 'decision'
       AND json_extract(payload, '$.decision') = 'budget_changed' AND json_extract(payload, '$.undoOf') = ?
     ORDER BY id LIMIT 1`,
  ).get(row.item_id, row.id) as { id: number } | undefined;
  return {
    activityId: row.id, ticketId: row.item_id, from, to, reason: typeof payload.reason === "string" ? payload.reason : "",
    at: row.created_at, undoneBy: undo?.id ?? null,
  };
}

/** Why this raise cannot be undone now (one sentence, no full stop). Null when it can. */
export function leadBudgetRaiseUndoBlocker(db: Db, raise: LeadBudgetRaise): string | null {
  const m = budgetMessages("zh");
  if (raise.undoneBy !== null) return m.undoDone;
  const item = getItem(db, raise.ticketId);
  if (!item) return m.undoGone;
  if (item.token_budget !== raise.to) return m.undoChanged(item.token_budget);
  return null;
}

export interface LeadBudgetRaiseUndone {
  ticketId: number;
  tokenBudget: number;
  activityId: number;
  eventSeq: number;
}

/** Put the token budget back to the value before Lead's raise. The caller checked leadBudgetRaiseUndoBlocker. */
export function undoLeadBudgetRaise(
  db: Db, raise: LeadBudgetRaise, meta: { actor: "user" | "lead"; reason: string; now: Date },
): LeadBudgetRaiseUndone {
  const done = db.transaction((): LeadBudgetRaiseUndone => {
    const item = getItem(db, raise.ticketId)!;
    const from = { tokenBudget: item.token_budget, costBudgetUsd: item.cost_budget_usd };
    const to = { tokenBudget: raise.from, costBudgetUsd: item.cost_budget_usd };
    db.prepare("UPDATE items SET token_budget=?, updated_at=datetime('now') WHERE id=?").run(raise.from, raise.ticketId);
    const activityId = addActivity(db, {
      itemId: raise.ticketId, actor: meta.actor, kind: "decision",
      payload: { decision: "budget_changed", from, to, reason: meta.reason, undoOf: raise.activityId },
    });
    const m = budgetMessages(getLocale(db));
    const summary = m.undone(meta.actor === "lead" ? leadDisplayName(db) : null, leadDisplayName(db), raise.ticketId, raise.to, raise.from);
    const eventSeq = reportBudgetChange(db, {
      ticketId: raise.ticketId, activityId, action: "undone", actor: meta.actor, undoOf: raise.activityId,
      fromTokens: raise.to, toTokens: raise.from, reason: redactSecretText(meta.reason), summary: redactSecretText(summary),
    }, meta.now);
    return { ticketId: raise.ticketId, tokenBudget: raise.from, activityId, eventSeq };
  }).immediate();
  publishGatewayEvent(db, itemUpdatedEvent(raise.ticketId));
  return done;
}
