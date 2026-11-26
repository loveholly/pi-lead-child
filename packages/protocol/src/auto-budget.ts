// The budget for automatic model calls (lead's auto-call-budget.ts, ticket #553): the limits that stop runaway
// automatic calls. Three limits: calls in the last hour, calls in the last 24 hours, and uncached input tokens in the last
// 24 hours. 0 means no limit.
// - Stored in config.json (lead.autoBudget), as before. The daemon reads it at startup; the operation writes it back and
//   applies it to the running budget at once, so a change needs no restart.
// - The operation is auto_budget.set (engine's ui-actions/auto-budget.ts): the settings page and Lead call the same
//   definition. lead_allowed, changes rules, only in the user's own turn: Lead can change it when the user asks, never
//   in a turn that an event, a timer or an external message woke (a runaway must not raise its own limit).
// - Read: GET /v1/lead/auto-budget (tickets:view). After a change the gateway sends snapshot.required with the payload
//   {resource: AUTO_BUDGET_RESOURCE}, and the client reads it again.
// This file does not import index.ts (index.ts re-exports from here).
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const AUTO_BUDGET_RESOURCE = "auto-budget";

/** The daemon has GET /v1/lead/auto-budget and auto_budget.set. Older daemons do not: the page does not show the card. */
export const AUTO_BUDGET_SETTINGS_CAPABILITY = "lead.auto-budget-settings.v1";

// Upper bounds against a typo (an extra zero is still allowed; three extra are not). 0 is no limit.
export const AUTO_BUDGET_MAX = { callsPerHour: 100_000, callsPerDay: 1_000_000, uncachedTokensPerDay: 100_000_000_000 } as const;

export const AUTO_BUDGET_KEYS = ["callsPerHour", "callsPerDay", "uncachedTokensPerDay"] as const;
export type AutoBudgetKey = typeof AUTO_BUDGET_KEYS[number];

export const AutoBudgetLimitsSchema = StrictObject({
  callsPerHour: Type.Integer({ minimum: 0, maximum: AUTO_BUDGET_MAX.callsPerHour }),
  callsPerDay: Type.Integer({ minimum: 0, maximum: AUTO_BUDGET_MAX.callsPerDay }),
  uncachedTokensPerDay: Type.Integer({ minimum: 0, maximum: AUTO_BUDGET_MAX.uncachedTokensPerDay }),
});
export type AutoBudgetLimits = Static<typeof AutoBudgetLimitsSchema>;

export const AutoBudgetDtoSchema = StrictObject({
  // The limits in force now.
  limits: AutoBudgetLimitsSchema,
  // The built-in defaults (what an empty field means).
  defaults: AutoBudgetLimitsSchema,
  // What automatic calls used in the windows the limits count (the settings page shows it next to each limit).
  usage: StrictObject({
    callsLastHour: Type.Integer({ minimum: 0 }),
    callsLastDay: Type.Integer({ minimum: 0 }),
    uncachedTokensLastDay: Type.Integer({ minimum: 0 }),
  }),
});
export type AutoBudgetDto = Static<typeof AutoBudgetDtoSchema>;

export const AutoBudgetResponseSchema = StrictObject({ autoBudget: AutoBudgetDtoSchema });
export type AutoBudgetResponse = Static<typeof AutoBudgetResponseSchema>;

// auto_budget.set input (POST /v1/actions/auto_budget/lead/set). Only the fields to change; at least one.
export const SetAutoBudgetRequestSchema = Type.Object({
  callsPerHour: Type.Optional(AutoBudgetLimitsSchema.properties.callsPerHour),
  callsPerDay: Type.Optional(AutoBudgetLimitsSchema.properties.callsPerDay),
  uncachedTokensPerDay: Type.Optional(AutoBudgetLimitsSchema.properties.uncachedTokensPerDay),
}, { additionalProperties: false, minProperties: 1 });
export type SetAutoBudgetRequest = Static<typeof SetAutoBudgetRequestSchema>;
