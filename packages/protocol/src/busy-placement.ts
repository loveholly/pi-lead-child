// 「Lead 忙时你发的消息」怎么放（用户 2026-11-09：「做到设置里面吧，由使用者决定，默认还是 follow up」）的线上契约。
// - 两个选项：followUp（排队，缺省）等 Lead 答完这一轮再交给它；steer（插话）直接插进 Lead 正在做的这一轮。
// - 存在 plc.db 的 kv（lead.busy-placement），一行 JSON：{ placement }（store 的 busy-placement.ts）。所有设备共用一份。
// - daemon 只在用户的消息没带 mode 时按它放（acceptChatMessage）。带了 mode 的消息照 mode 放。这一轮带着外部内容时，
//   用户的消息照旧等这一轮结束后单独开一轮（daemon 的 user-placement.ts），不看这个设置。
// - 改它是操作层的 busy_placement.set（engine 的 ui-actions/busy-placement.ts）：页面走 POST /v1/actions/busy_placement/lead/set，
//   Lead 走 perform_action。lead_allowed，改规则：读过外部内容的一轮里 Lead 改不了。
// - 读：GET /v1/lead/busy-placement（tickets:view）。变了以后网关发 snapshot.required，payload 是 {resource: "busy-placement"}，
//   客户端重新 GET。
// 这个文件不 import index.ts（index.ts 从这里 re-export，反过来会循环）。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const BUSY_PLACEMENT_RESOURCE = "busy-placement";

/**
 * daemon 在 hello.v2 的 capabilities 里报它：用户的消息没带 mode 时，daemon 按这个设置放。
 * 客户端看到它时，Lead 忙着也不再带 mode；旧 daemon 没有它，客户端照旧带 followUp（index.ts 的 CHAT_PLACEMENT_CAPABILITY）。
 */
export const CHAT_PLACEMENT_PREFERENCE_CAPABILITY = "chat.placement-preference.v1";

// 选项的顺序就是设置页上的顺序：缺省的排队在前。值和 chat.send 的 mode（index.ts 的 ChatPlacementSchema）一样。
export const BUSY_PLACEMENTS = ["followUp", "steer"] as const;
export const BusyPlacementSchema = Type.Union([Type.Literal("followUp"), Type.Literal("steer")]);
export type BusyPlacement = Static<typeof BusyPlacementSchema>;
export const DEFAULT_BUSY_PLACEMENT: BusyPlacement = "followUp";

export function isBusyPlacement(value: unknown): value is BusyPlacement {
  return typeof value === "string" && (BUSY_PLACEMENTS as readonly string[]).includes(value);
}

export const BusyPlacementDtoSchema = StrictObject({ placement: BusyPlacementSchema });
export type BusyPlacementDto = Static<typeof BusyPlacementDtoSchema>;

export const BusyPlacementResponseSchema = StrictObject({ busyPlacement: BusyPlacementDtoSchema });
export type BusyPlacementResponse = Static<typeof BusyPlacementResponseSchema>;

// busy_placement.set 的输入（POST /v1/actions/busy_placement/lead/set 的 input）。
export const SetBusyPlacementRequestSchema = StrictObject({ placement: BusyPlacementSchema });
export type SetBusyPlacementRequest = Static<typeof SetBusyPlacementRequestSchema>;
