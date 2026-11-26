// The budget for automatic model calls (ticket #553, protocol's auto-budget.ts). One operation: set.
// The page route (POST /v1/actions/auto_budget/lead/set) and Lead (perform_action) call this definition.
//   - set: user_only, only in the user's own turn (userTurnOnly), changes rules. The budget is the guard against runaway
//     automatic calls, so Lead never raises it on its own: not in a turn that an event, a timer or an external message
//     woke. When the user asks for a change in their own live turn, Lead can make it for them.
//   - The service (daemon's server.ts) writes config.json (lead.autoBudget) and applies the limits to the running budget
//     at once. No restart.
import { AUTO_BUDGET_KEYS, AUTO_BUDGET_RESOURCE, type AutoBudgetDto, type AutoBudgetLimits, type SetAutoBudgetRequest } from "@pi-lead-child/protocol";
import { publishGatewayEvent } from "@pi-lead-child/store";
import { AVAILABLE } from "../ticket-actions/types.js";
import { UiActionError, type AutoBudgetService, type UiActionDefinition, type UiActionEnv, type UiActionTargetKind } from "./types.js";

export const AUTO_BUDGET_WHERE = "设置 → Lead → 自动调用模型的上限";

export interface AutoBudgetChange {
  changed: boolean;
  before: AutoBudgetLimits;
  autoBudget: AutoBudgetDto;
}

function autoBudgetService(env: UiActionEnv): AutoBudgetService {
  const service = env.services.autoBudget;
  if (!service) throw new UiActionError("unavailable", "Lead 还没有启动，改不了自动调用的上限");
  return service;
}

function limitWords(limits: AutoBudgetLimits): string {
  const one = (value: number, unit: string) => (value === 0 ? "不限" : `${value.toLocaleString("en-US")} ${unit}`);
  return `每小时 ${one(limits.callsPerHour, "次")}，每天 ${one(limits.callsPerDay, "次")}，`
    + `每天没命中缓存的输入 ${one(limits.uncachedTokensPerDay, "token")}`;
}

export const AUTO_BUDGET_TARGET: UiActionTargetKind<AutoBudgetDto> = {
  type: "auto_budget",
  label: "自动调用模型的上限",
  idHint: "lead",
  load: (env, id) => (id === "lead" ? env.services.autoBudget?.get() ?? null : null),
  name: () => "自动调用模型的上限",
  describe: (state) => ({
    limits: state.limits,
    defaults: state.defaults,
    words: `现在是${limitWords(state.limits)}。只算系统自己发起的模型调用，用户本人的消息不算。超了就暂停自动调用，告诉用户。`,
  }),
};

export const AUTO_BUDGET_ACTIONS = {
  set: {
    target: "auto_budget", id: "set", label: "改自动调用模型的上限", scope: "tickets:create",
    permission: "user_only", userTurnOnly: true, changesRules: true, external: false, irreversible: false,
    permissionNote: "这是防止自动调用停不下来的上限：只有用户在这一轮明确要求时你才能代他改",
    where: AUTO_BUDGET_WHERE,
    hint: "只写要改的字段，都是非负整数，0 是不限：callsPerHour（最近一小时系统自己调模型的次数）、"
      + "callsPerDay（最近 24 小时的次数）、uncachedTokensPerDay（最近 24 小时没命中缓存的输入 token）。"
      + "写回 config.json 的 lead.autoBudget，马上生效，不用重启。只在用户这一轮明确要你改时改，照用户说的数字。",
    defaultReason: "在设置页改了自动调用模型的上限",
    available: () => AVAILABLE,
    run: (run): AutoBudgetChange => {
      const input = run.input as SetAutoBudgetRequest;
      const before = run.target.limits;
      const next: AutoBudgetLimits = { ...before };
      for (const key of AUTO_BUDGET_KEYS) {
        const value = input[key];
        if (value !== undefined) next[key] = value;
      }
      if (AUTO_BUDGET_KEYS.every((key) => next[key] === before[key])) return { changed: false, before, autoBudget: run.target };
      const autoBudget = autoBudgetService(run.env).set(next);
      // The settings page reads it again (GET /v1/lead/auto-budget).
      publishGatewayEvent(run.db, { type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: AUTO_BUDGET_RESOURCE } });
      return { changed: true, before, autoBudget };
    },
    forLead: (_run, result) => {
      const change = result as AutoBudgetChange;
      const { limits } = change.autoBudget;
      return change.changed
        ? { result: "updated", limits, next: `已经保存并生效：${limitWords(limits)}。用一句话告诉用户改了什么。` }
        : { result: "unchanged", limits };
    },
    detail: (_run, result) => {
      const change = result as AutoBudgetChange;
      return { before: change.before, after: change.autoBudget.limits };
    },
  },
} satisfies Record<string, UiActionDefinition<AutoBudgetDto, any>>;
