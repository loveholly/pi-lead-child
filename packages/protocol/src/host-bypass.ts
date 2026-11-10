// 「用户本人发话时免沙箱」开关（工单 #246 设计 docs/ticket-246-user-turn-bypass.md 第 5 节，实施单 A）的线上契约。
// - 开关打开时，只在用户本人正在发话、而且没读过外部内容的那一轮里，Lead 的 bash 在沙箱外跑，run_on_host 不弹卡
//   （执行路径是实施单 C）。这个文件只管开关本身：存储的形状、请求、事件。
// - 存在 plc.db 的 kv（lead.host-bypass），一行 JSON：{ enabled, bindingId, enabledAt, reason }（store 的 host-bypass.ts）。
// - 改用操作层的 host_bypass（engine 的 ui-actions/host-bypass.ts）：enable 是 user_direct，只有用户本人能在设置页打开；
//   disable 是 lead_allowed，用户和 Lead 都能关。
// - 打开不带时长，打开以后一直开着，直到用户或 Lead 关掉（用户 2026-11-10：「把 bypass 的时间限制去掉，也做成和 steer
//   一样的开关就好」）。2026-11-05 到 11-10 的版本打开时选 15–240 分钟，kv 里多存一个 until；读这种旧行的规则在 store 里。
// - 变化时网关发 snapshot.required，payload 是 {resource: "host-bypass"}，客户端重新 GET。
// 这个文件不 import index.ts（index.ts 从这里 re-export，反过来会循环）。
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { registerEventKind, type EventKindDefinition } from "./events.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const HOST_BYPASS_RESOURCE = "host-bypass";
// 事件的对象键。开关只有一个。
export const HOST_BYPASS_ENTITY_KEY = "host_bypass:lead";

export const HostBypassDtoSchema = StrictObject({
  // 现在是不是开着。
  enabled: Type.Boolean(),
  // 这次打开的时间（ISO）。关着时为 null。
  enabledAt: Nullable(Type.String()),
  // 在哪个配对凭证上打开的。关着时为 null。
  bindingId: Nullable(Type.Integer()),
  // 最近一次开或关的原因。从没开过时为 null。
  reason: Nullable(Type.String()),
});
export type HostBypassDto = Static<typeof HostBypassDtoSchema>;

export const HostBypassResponseSchema = StrictObject({ hostBypass: HostBypassDtoSchema });
export type HostBypassResponse = Static<typeof HostBypassResponseSchema>;

export const DEFAULT_HOST_BYPASS: HostBypassDto = Object.freeze({
  enabled: false, enabledAt: null, bindingId: null, reason: null,
});

// host_bypass.enable 的输入（POST /v1/lead/host-bypass/enable 的请求体）。不带时长。已经开着时再打开一次什么也不写。
export const EnableHostBypassRequestSchema = StrictObject({});
export type EnableHostBypassRequest = Static<typeof EnableHostBypassRequestSchema>;

// host_bypass.disable 的输入（POST /v1/lead/host-bypass/disable 的请求体）。
export const DisableHostBypassRequestSchema = StrictObject({});
export type DisableHostBypassRequest = Static<typeof DisableHostBypassRequestSchema>;

// ── 事件（设计文档 5.5）──────────────────────────────────────────────────────────

export const HOST_BYPASS_ENABLED_KIND = "host_bypass.enabled";
export const HOST_BYPASS_DISABLED_KIND = "host_bypass.disabled";
// 2026-11-05 到 11-10 的版本到点自动关时写的事件。现在不再产生；留着注册，事件表里的旧记录照旧能读。
export const HOST_BYPASS_EXPIRED_KIND = "host_bypass.expired";

export const HostBypassDisabledBySchema = Type.Union([Type.Literal("user"), Type.Literal("lead")]);
export type HostBypassDisabledBy = Static<typeof HostBypassDisabledBySchema>;

export const HOST_BYPASS_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    kind: HOST_BYPASS_ENABLED_KIND,
    sources: ["system"],
    // 旧版本的记录还多 until、minutes 两个字段：payload 不是严格对象，旧记录照旧通过。
    payload: Type.Object({
      bindingId: Nullable(Type.Integer()),
      // 谁在哪台设备上打开的，例如「user via Mac 网页（binding 3）」。
      resolvedBy: Type.String({ minLength: 1 }),
    }),
    description: "用户在设置页打开了「用户本人发话时免沙箱」。它一直开着，直到用户或 Lead 关掉。",
  },
  {
    kind: HOST_BYPASS_DISABLED_KIND,
    sources: ["system"],
    payload: Type.Object({
      by: HostBypassDisabledBySchema,
      // Lead 关的时候是 Lead 当时的轮次；用户在页面上关的时候为 null。
      turnId: Nullable(Type.String()),
      reason: Type.String(),
    }),
    description: "用户或 Lead 关掉了「用户本人发话时免沙箱」。",
  },
  {
    kind: HOST_BYPASS_EXPIRED_KIND,
    sources: ["system"],
    payload: Type.Object({ until: Type.String({ minLength: 1 }) }),
    description: "旧版本：「用户本人发话时免沙箱」到点自动关了。2026-11-10 去掉时限以后不再产生。",
  },
];

for (const definition of HOST_BYPASS_EVENT_KINDS) registerEventKind(definition);
