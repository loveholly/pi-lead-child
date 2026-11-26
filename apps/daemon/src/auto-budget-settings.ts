// The service behind auto_budget.set (engine's ui-actions/auto-budget.ts, ticket #553): the limits on automatic model
// calls. It writes config.json (lead.autoBudget), then gives the running AutoCallBudget the new limits, so the change
// applies at once and stays after a restart (the daemon reads lead.autoBudget at startup).
// hold: the model hold. A budget pause ends at once when the new limits are no longer exceeded.
import { loadPlcConfig, writePlcConfig } from "@pi-lead-child/core";
import type { AutoCallBudget, ModelHold } from "@pi-lead-child/lead";
import { DEFAULT_AUTO_CALL_BUDGET } from "@pi-lead-child/lead";
import type { AutoBudgetDto } from "@pi-lead-child/protocol";
import type { AutoBudgetService } from "@pi-lead-child/engine";

export function createAutoBudgetService(options: {
  dataDir: string;
  budget: AutoCallBudget;
  hold?: Pick<ModelHold, "state" | "resume">;
  log?: (line: string) => void;
}): AutoBudgetService {
  const state = (): AutoBudgetDto => ({
    limits: options.budget.limits, defaults: { ...DEFAULT_AUTO_CALL_BUDGET }, usage: options.budget.usage(),
  });
  return {
    get: state,
    set(limits) {
      const config = loadPlcConfig(options.dataDir);
      const lead = config.lead ?? {};
      writePlcConfig({ ...config, lead: { ...lead, autoBudget: { ...lead.autoBudget, ...limits } } }, options.dataDir);
      options.budget.setLimits(limits);
      options.log?.(`auto budget: limits changed to ${JSON.stringify(options.budget.limits)}`);
      if (options.hold?.state?.kind === "budget" && !options.budget.exceeded()) options.hold.resume("limits_changed");
      return state();
    },
  };
}
