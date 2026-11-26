// Ticket #562: Lead raises a ticket's token budget on its own.
// User 2026-11-26: "a few million more, decide it yourself and raise it, do not ask me again".
// Before, set_budget accepted only the user's own turn, so every budget stop woke Lead and Lead asked the user.
//   - In a turn that the system woke, Lead raises the token budget by at most 50% of it on its own.
//   - A larger raise, a lower budget, a cleared budget, a first budget, the USD budget and a turn that read outside content
//     are refused as before (needs_user_turn; the Lead tool turns that into a confirm card).
//   - Each raise goes into the ticket ledger and into "Lead 动态" with an undo button; the undo puts the budget back.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { TICKET_BUDGET_CHANGED_KIND, ticketBudgetEntityKey } from "@pi-lead-child/protocol";
import { createItem, createLoopbackBinding, createTurn, getItem, latestEntityEvent, listActivities, openDb, transition, type Db } from "@pi-lead-child/store";
import { runTicketAction, TicketActionError, type TicketActionCaller } from "../src/ticket-actions/index.js";
import { leadActivityCardAction } from "../src/ui-actions/card-actions.js";
import { runUiAction } from "../src/ui-actions/index.js";
import { UiActionError } from "../src/ui-actions/types.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-lead-budget-raise-"), "plc.db"));
});
afterEach(() => db.close());

// The turn that the budget stop woke: no user is talking.
const systemTurn = (): TicketActionCaller => {
  const turn = createTurn(db, { id: `wake-${Math.random()}`, originKind: "system:event", userText: "", state: "streaming" });
  return { kind: "lead", turnId: turn.id };
};

function ticket(tokenBudget: number | undefined, costBudgetUsd?: number): number {
  const itemId = createItem(db, {
    title: "写周报", brief: "b", createdBy: "lead",
    ...(tokenBudget !== undefined ? { tokenBudget } : {}), ...(costBudgetUsd !== undefined ? { costBudgetUsd } : {}),
  });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  return itemId;
}

async function refusal(promise: Promise<unknown>): Promise<TicketActionError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(TicketActionError);
  return error as TicketActionError;
}

const raise = (itemId: number, input: Record<string, unknown>, caller = systemTurn()) =>
  runTicketAction(db, { itemId, action: "set_budget", input, caller, reason: "用户说加几百万你自己判断；这一轮已经用掉 90%" });

describe("Lead raises a ticket's token budget on its own", () => {
  it("raises by up to 50% in a turn that the system woke, without the user's turn", async () => {
    const itemId = ticket(10_000_000);
    const outcome = await raise(itemId, { tokenBudget: 15_000_000 });
    expect(outcome).toMatchObject({ authority: "lead", by: { actor: "lead" } });
    expect(outcome.by).not.toHaveProperty("onBehalfOf");
    expect(getItem(db, itemId)!.token_budget).toBe(15_000_000);
    // Also with no turn at all (a heartbeat outside any turn).
    const second = await raise(itemId, { tokenBudget: 22_500_000 }, { kind: "lead", turnId: null });
    expect(second.authority).toBe("lead");
    expect(getItem(db, itemId)!.token_budget).toBe(22_500_000);
  });

  it("refuses a raise above 50% as before, and says how far Lead can go alone", async () => {
    const itemId = ticket(10_000_000);
    const error = await refusal(raise(itemId, { tokenBudget: 15_000_001 }));
    expect(error.code).toBe("needs_user_turn");
    expect(error.message).toContain("50%");
    expect(error.message).toContain("15,000,000");
    expect(getItem(db, itemId)!.token_budget).toBe(10_000_000);
    expect(listActivities(db, itemId).filter((row) => row.kind === "decision")).toEqual([]);
  });

  it("keeps the old rule for a lower budget, a cleared budget, a first budget, the USD budget and outside content", async () => {
    const itemId = ticket(10_000_000, 5);
    for (const input of [{ tokenBudget: 8_000_000 }, { tokenBudget: null }, { costBudgetUsd: 6 }, { tokenBudget: 12_000_000, costBudgetUsd: 6 }]) {
      expect((await refusal(raise(itemId, input))).code, JSON.stringify(input)).toBe("needs_user_turn");
    }
    const unbudgeted = ticket(undefined);
    expect((await refusal(raise(unbudgeted, { tokenBudget: 1_000_000 }))).code).toBe("needs_user_turn");
    const outside: TicketActionCaller = { kind: "lead", turnId: null, externalTurn: true };
    expect((await refusal(raise(itemId, { tokenBudget: 12_000_000 }, outside))).code).toBe("needs_user_turn");
    expect(getItem(db, itemId)).toMatchObject({ token_budget: 10_000_000, cost_budget_usd: 5 });
    expect(getItem(db, unbudgeted)!.token_budget).toBeNull();
  });

  it("still records a raise in the user's own turn as done for the user, with no Lead card", async () => {
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const turn = createTurn(db, { id: "turn-user", originBindingId: binding.id, originKind: "paired:companion", userText: "加到 3000 万", state: "streaming" });
    const itemId = ticket(10_000_000);
    const outcome = await raise(itemId, { tokenBudget: 30_000_000 }, { kind: "lead", turnId: turn.id });
    expect(outcome.authority).toBe("on_behalf");
    expect(getItem(db, itemId)!.token_budget).toBe(30_000_000);
    expect(latestEntityEvent(db, ticketBudgetEntityKey(itemId), TICKET_BUDGET_CHANGED_KIND)).toBeUndefined();
  });

  it("writes each raise to the ticket ledger and to Lead's activity with an undo that puts the budget back", async () => {
    const itemId = ticket(10_000_000);
    const outcome = await raise(itemId, { tokenBudget: 14_000_000 });

    // The ticket ledger.
    const ledger = listActivities(db, itemId).filter((row) => row.kind === "decision");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ actor: "lead" });
    expect(JSON.parse(ledger[0]!.payload as unknown as string)).toMatchObject({
      decision: "budget_changed", from: { tokenBudget: 10_000_000 }, to: { tokenBudget: 14_000_000 }, leadOwnRaise: true,
      reason: expect.stringContaining("加几百万"),
    });
    const activityId = ledger[0]!.id;
    expect(outcome.result).toMatchObject({ tokenBudget: 14_000_000, undo: { target: { type: "budget_raise", id: String(activityId) }, action: "undo" } });

    // "Lead 动态": a digest event that Lead has already seen, with the undo button.
    const event = latestEntityEvent(db, ticketBudgetEntityKey(itemId), TICKET_BUDGET_CHANGED_KIND)!;
    expect(event).toMatchObject({ level: "digest", source: "lead", disposition: "seen" });
    expect(event.payload).toMatchObject({ ticketId: itemId, activityId, action: "raised", actor: "lead", fromTokens: 10_000_000, toTokens: 14_000_000 });
    expect(String(event.payload.summary)).toContain(`#${itemId}`);
    expect(leadActivityCardAction(db, event)).toEqual({ target: { type: "budget_raise", id: String(activityId) }, action: "undo", label: "Undo" });

    // The user presses undo on the card.
    await runUiAction(db, { target: { type: "budget_raise", id: String(activityId) }, action: "undo", caller: { kind: "user" } });
    expect(getItem(db, itemId)!.token_budget).toBe(10_000_000);
    const undo = listActivities(db, itemId).filter((row) => row.kind === "decision").at(-1)!;
    expect(undo).toMatchObject({ actor: "user" });
    expect(JSON.parse(undo.payload as unknown as string)).toMatchObject({ decision: "budget_changed", to: { tokenBudget: 10_000_000 }, undoOf: activityId });
    const latest = latestEntityEvent(db, ticketBudgetEntityKey(itemId), TICKET_BUDGET_CHANGED_KIND)!;
    expect(latest.payload).toMatchObject({ action: "undone", actor: "user", undoOf: activityId });
    // The undo goes to Lead (no disposition yet), and the card has no button any more.
    expect(latest.disposition).toBeNull();
    expect(leadActivityCardAction(db, latest)).toBeNull();
    expect(leadActivityCardAction(db, event)).toBeNull();
    const again = await runUiAction(db, { target: { type: "budget_raise", id: String(activityId) }, action: "undo", caller: { kind: "user" } })
      .then(() => null, (error: unknown) => error);
    expect(again).toBeInstanceOf(UiActionError);
    expect((again as UiActionError).message).toContain("已经撤销过了");
  });

  it("does not undo a raise when the budget changed again after it", async () => {
    const itemId = ticket(10_000_000);
    await raise(itemId, { tokenBudget: 12_000_000 });
    const activityId = listActivities(db, itemId).filter((row) => row.kind === "decision")[0]!.id;
    await runTicketAction(db, { itemId, action: "set_budget", input: { tokenBudget: 40_000_000 }, caller: { kind: "user" } });
    const error = await runUiAction(db, { target: { type: "budget_raise", id: String(activityId) }, action: "undo", caller: { kind: "user" } })
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(UiActionError);
    expect(getItem(db, itemId)!.token_budget).toBe(40_000_000);
  });
});
