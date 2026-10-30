// 建议卡（首次启动引导，2026-10-30，.scratch/onboarding/spec.md）上的「以后再说」「不用再提」。
// 页面（POST /v1/actions/setup_hint/<卡的编号>/<操作>）和 Lead（perform_action）调同一个定义。
//   - 只改这张卡和这一项以后提不提，不改任何设置，也不进 Lead 的系统提示词：lead_allowed，不算改规则。
//   - 卡已经处理过（以后再说、不用再提）时 available 写明原因。
import { SETUP_ITEMS } from "@pi-lead-child/protocol";
import { getSetupHint, resolveSetupHint, type SetupHintRecord } from "@pi-lead-child/store";
import { AVAILABLE, unavailable } from "../ticket-actions/types.js";
import { UiActionError, type UiActionDefinition, type UiActionRun, type UiActionTargetKind } from "./types.js";

const WHERE = "会话里这张建议卡的「⋯」菜单";

function positiveId(id: string): number | null {
  const value = Number(id);
  return Number.isSafeInteger(value) && value >= 1 && String(value) === id ? value : null;
}

export const SETUP_HINT_TARGET: UiActionTargetKind<SetupHintRecord> = {
  type: "setup_hint",
  label: "建议设置的卡",
  idHint: "建议卡的编号（hintId）",
  load: (env, id) => {
    const hintId = positiveId(id);
    return hintId === null ? null : getSetupHint(env.db, hintId);
  },
  name: (hint) => `建议配「${SETUP_ITEMS[hint.item].title}」的卡 #${hint.id}`,
  describe: (hint) => ({ item: hint.item, state: hint.state, at: hint.at }),
};

function availableWhileOpen(hint: SetupHintRecord) {
  if (hint.state === "snoozed") return unavailable("这张卡已经选了「以后再说」");
  if (hint.state === "dismissed") return unavailable("这张卡已经选了「不用再提」");
  return AVAILABLE;
}

function resolve(run: UiActionRun<SetupHintRecord, unknown>, choice: "snoozed" | "dismissed"): SetupHintRecord {
  const resolved = resolveSetupHint(run.db, run.target.id, choice, run.env.now);
  if (!resolved) throw new UiActionError("not_found", `建议卡 #${run.target.id} 不在了`);
  return resolved;
}

export const SETUP_HINT_ACTIONS = {
  snooze: {
    target: "setup_hint", id: "snooze", label: "以后再说", scope: "chat",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: WHERE,
    hint: "建议卡上的「以后再说」：这一项 7 天内不再提。",
    defaultReason: "这一项以后再说",
    available: (hint) => availableWhileOpen(hint),
    run: (run) => resolve(run, "snoozed"),
    forLead: (run) => ({ result: "snoozed", item: run.target.item, next: "这一项 7 天内不再提。不用再告诉用户。" }),
    detail: (run) => ({ item: run.target.item }),
  },
  dismiss: {
    target: "setup_hint", id: "dismiss", label: "不用再提", scope: "chat",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: WHERE,
    hint: "建议卡上的「不用再提」：这一项以后都不再提。用户以后可以自己去设置页配。",
    defaultReason: "这一项不用再提",
    available: (hint) => availableWhileOpen(hint),
    run: (run) => resolve(run, "dismissed"),
    forLead: (run) => ({ result: "dismissed", item: run.target.item, next: "这一项以后不再提。不用再告诉用户。" }),
    detail: (run) => ({ item: run.target.item }),
  },
} satisfies Record<string, UiActionDefinition<SetupHintRecord, any>>;
