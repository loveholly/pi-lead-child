// 「用户本人发话时免沙箱」开关（docs/ticket-246-user-turn-bypass.md 5.1，实施单 A）的操作：打开（enable）和关掉（disable）。
// 页面（gateway 的 host-bypass-routes.ts）和 Lead（perform_action）调同一个定义。
//   - enable：user_direct，改规则。开关授予 Lead 权力（AGENTS.md UI Actions），只有用户本人能在设置页点。
//     Lead 调它总是拿到结构化的拒绝，拒绝里写设置页的位置；Lead 不发「要不要打开？」这样的卡。
//     不带时长：打开以后一直开着，直到用户或 Lead 关掉（用户 2026-11-10）。已经开着时再打开一次什么也不写。
//   - disable：lead_allowed，不改规则。用户和 Lead 都能关。已经关着时再关一次什么也不写。
import type { HostBypassDto } from "@pi-lead-child/protocol";
import { getBinding, getHostBypass } from "@pi-lead-child/store";
import { disableHostBypass, enableHostBypass, HOST_BYPASS_WHERE, type HostBypassChange } from "../host-bypass.js";
import { AVAILABLE } from "../ticket-actions/types.js";
import type { UiActionDefinition, UiActionTargetKind } from "./types.js";

export const HOST_BYPASS_TARGET: UiActionTargetKind<HostBypassDto> = {
  type: "host_bypass",
  label: "用户本人发话时免沙箱",
  idHint: "lead",
  load: (env, id) => (id === "lead" ? getHostBypass(env.db, env.now) : null),
  name: () => "用户本人发话时免沙箱",
  describe: (state) => ({
    enabled: state.enabled,
    words: "开着时，只在用户本人正在发话、而且这一轮没读过外部内容时，你的命令在沙箱外跑。没有时限：一直开着，直到用户或你关掉。",
  }),
};

function resolvedByOf(db: Parameters<typeof getBinding>[0], bindingId: number | null): string {
  const binding = bindingId === null ? null : getBinding(db, bindingId);
  return binding ? `user via ${binding.display_name}（binding ${binding.id}）` : "user via page";
}

export const HOST_BYPASS_ACTIONS = {
  enable: {
    target: "host_bypass", id: "enable", label: "打开用户本人发话时免沙箱", scope: "tickets:create",
    permission: "user_direct", changesRules: true, external: false, irreversible: false,
    where: HOST_BYPASS_WHERE,
    hint: "只有用户本人能在设置页打开：你调用总是被拒绝。用户要你打开时，告诉用户去 " + HOST_BYPASS_WHERE
      + " 里打开。打开以后一直开着，直到用户或你关掉。不要发确认卡。",
    defaultReason: "在设置页打开了免沙箱",
    available: () => AVAILABLE,
    run: (run) => enableHostBypass(run.db, {
      bindingId: run.bindingId, resolvedBy: resolvedByOf(run.db, run.bindingId), reason: run.reason, now: run.env.now,
    }),
    forLead: (_run, result) => ({ enabled: (result as HostBypassChange).hostBypass.enabled }),
    detail: (_run, result) => ({ changed: (result as HostBypassChange).changed }),
  },
  disable: {
    target: "host_bypass", id: "disable", label: "关掉用户本人发话时免沙箱", scope: "tickets:create",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: HOST_BYPASS_WHERE,
    hint: "关掉免沙箱：以后的命令都在沙箱里跑，沙箱外的事照旧发确认卡。用户说「关掉」、或者你认为不该再开着时用。已经关着时什么也不做。",
    defaultReason: "关掉了免沙箱",
    available: () => AVAILABLE,
    run: (run) => disableHostBypass(run.db, {
      by: run.by.actor, turnId: run.turnId, reason: run.reason, now: run.env.now,
    }),
    forLead: (_run, result) => {
      const { changed } = result as HostBypassChange;
      return changed ? { result: "disabled" } : { result: "unchanged", note: "免沙箱本来就是关着的" };
    },
    detail: (_run, result) => ({ changed: (result as HostBypassChange).changed }),
  },
} satisfies Record<string, UiActionDefinition<HostBypassDto, any>>;
