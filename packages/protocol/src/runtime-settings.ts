// 执行器（child runtime）的设置（设置页「执行器」，2026-10-19）的线上契约。
// - 用户可以停用一个 runtime。停用后派发、选核查员和 Lead 的选型建议都跳过它，点名它的派发挂起等 Lead 改派。
//   2026-10-19 以前，「不用 codex」只记在 Lead 的笔记里，系统不读笔记，所以 Lead 照样推荐 codex。
// - 名单存在 config.json 的 runtimes.disabled。改了立即生效，不用重启 daemon。
// - 读用 tickets:view，改用 tickets:create（和 /v1/decision-model 一样）。
// - Lead 也能拨（2026-10-22）：它的 perform_action 和这条路由都经过操作层（engine 的 ui-actions/ 的 runtime 的 disable、enable），
//   再调 daemon 的同一个函数（apps/daemon 的 runtime-settings.ts）。
//   谁停用的、为什么只记在 config.json 里，这里的 DTO 不加字段：它是严格的契约，加字段旧客户端会失败。
// - 变化时网关发 snapshot.required，payload 是 {resource: "runtime-settings"}，客户端重新 GET。
import { Type, type Static, type TProperties } from "typebox";
import { KernelRuntimeIdSchema } from "./runtime-ids.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const RuntimeSettingEntrySchema = StrictObject({
  id: KernelRuntimeIdSchema,
  // 展示名（runtime adapter 声明的，例如 Codex、Claude Code）。
  label: Type.String({ minLength: 1, maxLength: 60 }),
  enabled: Type.Boolean(),
  // 本机找得到它的可执行文件。
  installed: Type.Boolean(),
  // 当核查员时能跑命令（可执行的只读核查，现在只有 Codex）。2026-10-20 起任何 runtime 都能当核查员，
  // 这一项只说明它核查时能不能实际运行测试；能的排在前面。
  canReview: Type.Boolean(),
});
export type RuntimeSettingEntry = Static<typeof RuntimeSettingEntrySchema>;

export const RuntimeSettingsDtoSchema = StrictObject({
  runtimes: Type.Array(RuntimeSettingEntrySchema, { maxItems: 16 }),
  // 下一次自动核查用哪个 runtime；canReview=false 表示所有执行器都停用了，核查请求派不出去。
  // 有故障的核查员不在这里看（这里不查健康账本），派发时会被自动换掉。
  reviewer: StrictObject({ id: KernelRuntimeIdSchema, canReview: Type.Boolean() }),
});
export type RuntimeSettingsDto = Static<typeof RuntimeSettingsDtoSchema>;

export const RuntimeSettingsResponseSchema = StrictObject({ runtimeSettings: RuntimeSettingsDtoSchema });
export type RuntimeSettingsResponse = Static<typeof RuntimeSettingsResponseSchema>;

// POST /v1/runtimes/settings：一次拨一个开关。
export const RuntimeSettingsRequestSchema = StrictObject({
  runtime: KernelRuntimeIdSchema,
  enabled: Type.Boolean(),
});
export type RuntimeSettingsRequest = Static<typeof RuntimeSettingsRequestSchema>;
