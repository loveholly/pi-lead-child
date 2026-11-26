// Lead raises a ticket's token budget on its own (ticket #562, user 2026-11-26: "a few million more, decide it yourself, do not ask").
//   - In any turn, Lead can raise the token budget by at most LEAD_BUDGET_RAISE_MAX_RATIO of the current budget.
//     A larger raise, a lower budget, a cleared budget and the USD budget still need the user's own turn (or the confirm card).
//   - Each raise that Lead makes on its own writes one ticket_budget.changed event (digest level). "Lead 动态" shows a card
//     with an undo button (engine ui-actions/card-actions.ts; the operation is budget_raise / <activity id> / undo).
//   - An undo writes one more event on the same object, so the card updates in place and the button goes away.
// The engine does the work in ticket-actions/budget-raise.ts.
import { Type, type Static } from "typebox";
import { registerEventKind, type EventKindDefinition } from "./events.ts";

/** The largest raise Lead may make on its own, as a share of the current token budget. */
export const LEAD_BUDGET_RAISE_MAX_RATIO = 0.5;

export const TICKET_BUDGET_CHANGED_KIND = "ticket_budget.changed";

/** The object key of a ticket's budget: ticket_budget:<ticket id>. It is not ticket:<id>, so stage changes do not hide the undo. */
export function ticketBudgetEntityKey(ticketId: number): string {
  return `ticket_budget:${ticketId}`;
}

const Id = Type.Integer({ minimum: 1 });
const Tokens = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);

export const TicketBudgetChangedPayloadSchema = Type.Object({
  ticketId: Id,
  // The ledger row (activities, decision budget_changed) of the raise. The undo operation uses it as its id.
  activityId: Id,
  // raised: Lead raised the budget. undone: someone undid that raise.
  action: Type.Union([Type.Literal("raised"), Type.Literal("undone")]),
  actor: Type.Union([Type.Literal("user"), Type.Literal("lead")]),
  // For an undo: the ledger row of the raise that it undid. Null for a raise.
  undoOf: Type.Union([Id, Type.Null()]),
  fromTokens: Tokens,
  toTokens: Tokens,
  reason: Type.String(),
  // The sentence for the user, in the language the user had chosen when it was written.
  summary: Type.String(),
});
export type TicketBudgetChangedPayload = Static<typeof TicketBudgetChangedPayloadSchema>;

export const TICKET_BUDGET_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    // Lead raised a ticket's token budget on its own, or someone undid such a raise. Digest level: "Lead 动态" tells the user.
    // A raise by Lead has the source lead; an undo by the user has the source system (the source user is only for messages to Lead).
    kind: TICKET_BUDGET_CHANGED_KIND,
    sources: ["lead", "system"],
    payload: TicketBudgetChangedPayloadSchema,
    description: "Lead raised a ticket's token budget on its own (at most 50% of the current budget), or someone undid that raise.",
  },
];

for (const definition of TICKET_BUDGET_EVENT_KINDS) registerEventKind(definition);
