// 设置 → 记忆的 Hindsight 部分（2026-10-29，.scratch/hindsight-primary-memory/spec.md D3、D16）的操作：摘要模型、重试失败的写入。
// 页面（POST /v1/actions/memory_settings/memory/<操作>）和 Lead（perform_action）调同一个定义，服务是 daemon 的 memory-controller.ts。
//   - set_summary_model：设置页的选项，算改规则（AGENTS.md）。Lead 在自己的回合里可以改；读过外部内容的回合里被拒，
//     拒绝里带确认卡。模型来自 Lead 自己的服务商：笔记不会发给一个 Lead 没在用的主机，所以不用另外确认。
//   - test_summary_model：只读。
//   - retry_failed_writes：失败的笔记重新写进 Hindsight。不改规则。
import type { SetSummaryModelRequest, SummaryModelSlotRequest } from "@pi-lead-child/protocol";
import { AVAILABLE, unavailable } from "../ticket-actions/types.js";
import {
  UiActionError,
  type MemorySettingsChange, type MemorySettingsService, type MemorySettingsSummary, type UiActionDefinition, type UiActionEnv,
  type UiActionTargetKind,
} from "./types.js";

export const MEMORY_SETTINGS_WHERE = "设置 → 记忆";

function memorySettings(env: UiActionEnv): MemorySettingsService {
  const service = env.services.memorySettings;
  if (!service) throw new UiActionError("unavailable", "这台 daemon 不托管记忆服务（Hindsight）");
  return service;
}

export const MEMORY_SETTINGS_TARGET: UiActionTargetKind<MemorySettingsSummary> = {
  type: "memory_settings",
  label: "记忆设置",
  idHint: "memory",
  load: (env, id) => (id === "memory" ? env.services.memorySettings?.summary() ?? null : null),
  name: () => "记忆设置",
  describe: (summary) => ({
    enabled: summary.enabled, summaryModels: summary.summaryModels, writes: summary.writes,
    words: "摘要模型是 Hindsight 提取事实（缺省）和整理观察用的 LLM。改了以后记忆服务重启几秒，期间召回只用全文检索。",
  }),
};

const changeForLead = (_run: unknown, result: unknown) => {
  const change = result as MemorySettingsChange;
  return { result: "done", summary: change.summary, ...(change.note ? { note: change.note } : {}) };
};
const changeDetail = (_run: unknown, result: unknown) => ({ summary: (result as MemorySettingsChange).summary });

export const MEMORY_SETTINGS_ACTIONS = {
  set_summary_model: {
    target: "memory_settings", id: "set_summary_model", label: "选摘要模型", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, external: false, irreversible: false,
    where: MEMORY_SETTINGS_WHERE,
    hint: "选 Hindsight 的摘要模型。slot 是 default（提取事实，也是缺省）或 consolidation（整理观察）；"
      + "model 写 list_lead_models 列出的 provider/id，null 时缺省槽改回自动（最新的 haiku），整理观察槽改回跟缺省一样。"
      + "改了以后记忆服务重启几秒，期间 search_notes 只用全文检索。",
    defaultReason: "在设置页选了摘要模型",
    available: () => AVAILABLE,
    run: (run) => memorySettings(run.env).setSummaryModel(run.input as SetSummaryModelRequest),
    forLead: changeForLead,
    detail: changeDetail,
  },
  test_summary_model: {
    target: "memory_settings", id: "test_summary_model", label: "测试摘要模型", scope: "tickets:view",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false, readOnly: true,
    where: MEMORY_SETTINGS_WHERE,
    hint: "测一个槽现在用的摘要模型能不能用：用它的服务商发一次很小的补全。只读。",
    defaultReason: "测试摘要模型",
    available: () => AVAILABLE,
    run: (run) => memorySettings(run.env).testSummaryModel((run.input as SummaryModelSlotRequest).slot),
    forLead: (_run, result) => result,
  },
  retry_failed_writes: {
    target: "memory_settings", id: "retry_failed_writes", label: "重试失败的写入", scope: "tickets:create",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: MEMORY_SETTINGS_WHERE,
    hint: "修好写入失败的原因（例如摘要模型的 key）以后，让失败的笔记重新写进 Hindsight。",
    defaultReason: "重试失败的记忆写入",
    available: (summary) => (summary.writes.failed > 0 ? AVAILABLE : unavailable("没有写入失败的笔记")),
    run: (run) => memorySettings(run.env).retryFailedWrites(),
    forLead: changeForLead,
    detail: changeDetail,
  },
} satisfies Record<string, UiActionDefinition<MemorySettingsSummary, any>>;
