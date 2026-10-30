// 设置 → 模型（2026-10-29，.scratch/model-settings/spec.md D10）的操作：大脑和直觉的分工、服务商、直觉的每一条。
// 页面（POST /v1/actions/model_settings/models/<操作>）和 Lead（perform_action）调同一个定义，服务是 daemon 的 model-settings.ts。
//   - set_brain_chain、set_fast_chain：user_only，和输入框换模型（lead_model/switch）同一类，不算改规则。
//   - save_provider、remove_provider、save_fast_model、remove_fast_model：user_direct。它们决定 Lead 的对话、要判断的内容发给谁，
//     还带 key（AGENTS.md：带密钥的操作只有用户本人能做）。Lead 调用时拿到拒绝，拒绝里写明去哪里点。
//   - test_fast_model：只读，Lead 可以自己做。
// 账本只记 detail（不记输入）：key 不进事件日志。
import type {
  FastModelIdRequest, RemoveModelProviderRequest, SaveFastModelRequest, SaveModelProviderRequest, SetBrainChainRequest,
  SetFastChainRequest,
} from "@pi-lead-child/protocol";
import { AVAILABLE } from "../ticket-actions/types.js";
import {
  UiActionError,
  type ModelSettingsChange, type ModelSettingsService, type ModelSettingsSummary, type UiActionDefinition, type UiActionEnv,
  type UiActionTargetKind,
} from "./types.js";

export const MODEL_SETTINGS_WHERE = "设置 → 模型";

function modelSettings(env: UiActionEnv): ModelSettingsService {
  const service = env.services.modelSettings;
  if (!service) throw new UiActionError("unavailable", "模型设置还没有启动（Lead 的会话还没建好）");
  return service;
}

export const MODEL_SETTINGS_TARGET: UiActionTargetKind<ModelSettingsSummary> = {
  type: "model_settings",
  label: "模型设置",
  idHint: "models",
  load: (env, id) => (id === "models" ? env.services.modelSettings?.summary() ?? null : null),
  name: () => "模型设置",
  describe: (summary) => ({
    brain: summary.brain, fast: summary.fast, maxBackups: summary.maxBackups,
    words: "大脑是你自己的模型（LLM），直觉是决策模型。每类一个主用、最多 3 个备用。",
  }),
};

const changeForLead = (_run: unknown, result: unknown) => {
  const change = result as ModelSettingsChange;
  return { result: "done", summary: change.summary, ...(change.applied ? { applied: change.applied } : {}), ...(change.note ? { note: change.note } : {}) };
};
const changeDetail = (_run: unknown, result: unknown) => {
  const change = result as ModelSettingsChange;
  return { summary: change.summary, ...(change.applied ? { applied: change.applied } : {}) };
};
const USER_DIRECT_WHY = "它决定把对话发给谁，还带 key：只有用户本人能在设置页上做";

export const MODEL_SETTINGS_ACTIONS = {
  set_brain_chain: {
    target: "model_settings", id: "set_brain_chain", label: "改大脑的主用和备用", scope: "chat",
    // 和输入框换模型同一类（lead_model/switch）：用户 2026-10-27 定，换 Lead 的模型不算改规则。
    permission: "user_only", changesRules: false, external: false, irreversible: false,
    where: MODEL_SETTINGS_WHERE,
    hint: "用户要你改自己的主用模型或备用模型时用。models 是整条分工：第一个主用，后面最多 3 个备用，"
      + "每项写 list_lead_models 列出的 provider/id 和推理强度（effort，或者 null）。Lead 空闲时马上换，正在回答时这一轮结束后换。",
    defaultReason: "在设置页改了大脑的主用和备用",
    available: () => AVAILABLE,
    run: (run) => modelSettings(run.env).setBrainChain(run.input as SetBrainChainRequest),
    forLead: changeForLead,
    detail: changeDetail,
  },
  save_provider: {
    target: "model_settings", id: "save_provider", label: "接入或修改服务商", scope: "tickets:create",
    permission: "user_direct", permissionNote: USER_DIRECT_WHY,
    changesRules: true, external: false, irreversible: false,
    where: MODEL_SETTINGS_WHERE,
    hint: "接入一个模型服务商（地址、接口格式、key）。只有用户本人能在设置页上做：调用会被拒绝，把拒绝里的地方告诉用户。",
    defaultReason: "在设置页保存了服务商",
    available: () => AVAILABLE,
    run: (run) => modelSettings(run.env).saveProvider(run.input as SaveModelProviderRequest),
    forLead: changeForLead,
    detail: (run, result) => ({ name: (run.input as SaveModelProviderRequest).name, summary: (result as ModelSettingsChange).summary }),
  },
  remove_provider: {
    target: "model_settings", id: "remove_provider", label: "删掉服务商", scope: "tickets:create",
    permission: "user_direct", permissionNote: USER_DIRECT_WHY,
    changesRules: true, external: false, irreversible: false,
    where: MODEL_SETTINGS_WHERE,
    hint: "删掉一个模型服务商。只有用户本人能在设置页上做。它的模型在分工里时会被拒绝。",
    defaultReason: "在设置页删掉了服务商",
    available: () => AVAILABLE,
    run: (run) => modelSettings(run.env).removeProvider((run.input as RemoveModelProviderRequest).name),
    forLead: changeForLead,
    detail: changeDetail,
  },
  save_fast_model: {
    target: "model_settings", id: "save_fast_model", label: "添加或修改直觉", scope: "tickets:create",
    permission: "user_direct", permissionNote: USER_DIRECT_WHY,
    changesRules: true, external: false, irreversible: false,
    where: MODEL_SETTINGS_WHERE,
    hint: "添加或修改一条直觉（决策模型：名字、地址、模型、key）。只有用户本人能在设置页上做。",
    defaultReason: "在设置页保存了直觉",
    available: () => AVAILABLE,
    run: (run) => modelSettings(run.env).saveFastModel(run.input as SaveFastModelRequest),
    forLead: changeForLead,
    detail: (run, result) => ({
      id: (result as ModelSettingsChange).id ?? (run.input as SaveFastModelRequest).id ?? null,
      summary: (result as ModelSettingsChange).summary,
    }),
  },
  remove_fast_model: {
    target: "model_settings", id: "remove_fast_model", label: "删掉直觉", scope: "tickets:create",
    permission: "user_direct", permissionNote: USER_DIRECT_WHY,
    changesRules: true, external: false, irreversible: false,
    where: MODEL_SETTINGS_WHERE,
    hint: "删掉一条直觉。只有用户本人能在设置页上做。它在分工里时会被拒绝。",
    defaultReason: "在设置页删掉了直觉",
    available: () => AVAILABLE,
    run: (run) => modelSettings(run.env).removeFastModel((run.input as FastModelIdRequest).id),
    forLead: changeForLead,
    detail: changeDetail,
  },
  set_fast_chain: {
    target: "model_settings", id: "set_fast_chain", label: "改直觉的主用和备用", scope: "chat",
    permission: "user_only", changesRules: false, external: false, irreversible: false,
    where: MODEL_SETTINGS_WHERE,
    hint: "用户要你改直觉（决策模型）的主用、备用，或者都用不了时问大脑的哪个模型时用。chain 是直觉的编号（list_actions 的 fast.models），"
      + "第一个主用，后面最多 3 个备用；空数组表示不用直觉。llmFallback 写 provider/id 和推理强度，null 表示系统自己选，不写表示不变。"
      + "下一次判断就生效。",
    defaultReason: "在设置页改了直觉的主用和备用",
    available: () => AVAILABLE,
    run: (run) => modelSettings(run.env).setFastChain(run.input as SetFastChainRequest),
    forLead: changeForLead,
    detail: changeDetail,
  },
  test_fast_model: {
    target: "model_settings", id: "test_fast_model", label: "测试直觉", scope: "tickets:view",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false, readOnly: true,
    where: MODEL_SETTINGS_WHERE,
    hint: "测一条直觉能不能用：用它存的 key 发一次很小的判断。只读。",
    defaultReason: "测试直觉",
    available: () => AVAILABLE,
    run: (run) => modelSettings(run.env).testFastModel((run.input as FastModelIdRequest).id),
    forLead: (_run, result) => result,
  },
} satisfies Record<string, UiActionDefinition<ModelSettingsSummary, any>>;
