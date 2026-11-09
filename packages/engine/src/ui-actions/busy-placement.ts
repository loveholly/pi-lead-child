// 「Lead 忙时你发的消息」怎么放（用户 2026-11-09，protocol 的 busy-placement.ts）的操作：set。
// 页面（POST /v1/actions/busy_placement/lead/set）和 Lead（perform_action）调同一个定义。
//   - set：lead_allowed，改规则（设置页的选项，AGENTS.md「UI Actions」）。Lead 在没读过外部内容的一轮里可以自己改；
//     外部消息叫醒的一轮、读过外部内容的一轮里被拒，拒绝里带确认卡。不进系统提示词，也不只限用户本人的一轮。
//   - 值没变时什么也不写，不发通知。变了以后发 snapshot.required（busy-placement），每台设备重新读。
// daemon 在用户的消息没带 mode 时按这个设置放（apps/daemon 的 acceptChatMessage）。
import {
  BUSY_PLACEMENT_RESOURCE,
  type BusyPlacement, type BusyPlacementDto, type SetBusyPlacementRequest,
} from "@pi-lead-child/protocol";
import { getBusyPlacement, publishGatewayEvent, writeBusyPlacement } from "@pi-lead-child/store";
import { AVAILABLE } from "../ticket-actions/types.js";
import type { UiActionDefinition, UiActionTargetKind } from "./types.js";

export const BUSY_PLACEMENT_WHERE = "设置 → Lead → 身份与风格（Lead 忙时你发的消息）";

export interface BusyPlacementChange {
  changed: boolean;
  before: BusyPlacement;
  busyPlacement: BusyPlacementDto;
}

const WORDS: Record<BusyPlacement, string> = {
  followUp: "排队：你正忙时用户发的话等你答完这一轮再交给你，用户可以在输入框上方的排队栏里点 Steer 把某一条马上插进来",
  steer: "插话：你正忙时用户发的话直接插进你正在做的这一轮",
};

export const BUSY_PLACEMENT_TARGET: UiActionTargetKind<BusyPlacementDto> = {
  type: "busy_placement",
  label: "Lead 忙时用户发的消息",
  idHint: "lead",
  load: (env, id) => (id === "lead" ? getBusyPlacement(env.db) : null),
  name: () => "Lead 忙时用户发的消息",
  describe: (state) => ({
    placement: state.placement,
    words: `现在是${WORDS[state.placement]}。只管用户发消息时没有自己选的情况；这一轮带着外部内容时，用户的话照旧等这一轮结束后单独开一轮。`,
  }),
};

export const BUSY_PLACEMENT_ACTIONS = {
  set: {
    target: "busy_placement", id: "set", label: "选 Lead 忙时用户发的消息怎么放", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, external: false, irreversible: false,
    where: BUSY_PLACEMENT_WHERE,
    hint: "placement 写 followUp（排队，缺省：等你答完这一轮再交给你）或 steer（插话：直接插进你正在做的这一轮）。"
      + "用户说「我发的话直接插进来」「忙的时候先排着」这类话时用。所有设备一起生效，下一条消息起按新的放。",
    defaultReason: "在设置页选了 Lead 忙时消息怎么放",
    available: () => AVAILABLE,
    run: (run): BusyPlacementChange => {
      const { placement } = run.input as SetBusyPlacementRequest;
      const before = run.target.placement;
      if (before === placement) return { changed: false, before, busyPlacement: run.target };
      writeBusyPlacement(run.db, placement);
      publishGatewayEvent(run.db, { type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: BUSY_PLACEMENT_RESOURCE } });
      return { changed: true, before, busyPlacement: getBusyPlacement(run.db) };
    },
    forLead: (_run, result) => {
      const change = result as BusyPlacementChange;
      const { placement } = change.busyPlacement;
      return change.changed
        ? { result: "updated", placement, next: `已经保存：下一条消息起，${WORDS[placement]}。用一句话告诉用户改了什么。` }
        : { result: "unchanged", placement };
    },
    detail: (_run, result) => {
      const change = result as BusyPlacementChange;
      return { before: change.before, after: change.busyPlacement.placement };
    },
  },
} satisfies Record<string, UiActionDefinition<BusyPlacementDto, any>>;
