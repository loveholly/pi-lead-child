// 来源的固定订阅（设置 → 消息通道 → 固定订阅，用户 2026-11-25）的操作。页面和 Lead（perform_action）调同一个定义，
// 都经过 daemon 的通道设置（services.channelSubscriptions）。这里不认识具体的来源：条目怎么写、怎么认由来源定义
// （ChannelAdapter.subscriptions）。
//   - pin：固定订阅一个对话。不管最近有没有对话都算订阅，消息照订阅对话的规则处理（只记录、沉淀进记忆）。改规则（changesRules），
//     Lead 可以做；外部消息叫醒的一轮、读过外部内容的一轮按改规则的护栏拒绝。
//   - unpin：取消一个固定订阅。同上。
// 排除名单（来源的配置）优先于固定订阅，这里只读。
import type { UiActionInputOf } from "@pi-lead-child/protocol";
import { AVAILABLE, unavailable } from "../ticket-actions/types.js";
import {
  UiActionError, type ChannelSubscriptionService, type ChannelSubscriptionsState, type UiActionDefinition, type UiActionEnv,
  type UiActionTargetKind,
} from "./types.js";

export const CHANNEL_SUBSCRIPTIONS_WHERE = "设置 → 消息通道 → 固定订阅";

function service(env: UiActionEnv): ChannelSubscriptionService {
  const found = env.services.channelSubscriptions;
  if (!found) throw new UiActionError("unavailable", "消息通道还没有启动");
  return found;
}

export const CHANNEL_SUBSCRIPTIONS_TARGET: UiActionTargetKind<ChannelSubscriptionsState> = {
  type: "channel_subscriptions",
  label: "消息通道的固定订阅",
  idHint: "来源，例如 slack",
  load: (env, id) => env.services.channelSubscriptions?.subscriptions(id) ?? null,
  name: (target) => `${target.label} 的固定订阅`,
  describe: (target) => ({ ...target }),
};

export const CHANNEL_SUBSCRIPTIONS_ACTIONS = {
  pin: {
    target: "channel_subscriptions", id: "pin", label: "固定订阅一个对话", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, external: false, irreversible: false,
    where: CHANNEL_SUBSCRIPTIONS_WHERE,
    hint: "用户要长期跟踪一个频道、把它的进展沉淀进记忆时用：固定以后不管最近有没有人和用户说话都算订阅，"
      + "消息只记录、沉淀进记忆，不开卡。entry 的写法看对象的 entryHint。排除名单（excluded）里的频道即使固定了也不订阅。马上生效。",
    defaultReason: "在设置页固定订阅了一个对话",
    available: () => AVAILABLE,
    run: (run) => {
      const { entry } = run.input as UiActionInputOf<"channel_subscriptions", "pin">;
      return service(run.env).pin(run.target.source, entry);
    },
    forLead: (_run, result) => result,
    detail: (run) => ({ entry: (run.input as { entry: string }).entry }),
  },
  unpin: {
    target: "channel_subscriptions", id: "unpin", label: "取消固定订阅", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, external: false, irreversible: false,
    where: CHANNEL_SUBSCRIPTIONS_WHERE,
    hint: "取消一个固定订阅。之后这个频道和别的频道一样：14 天内和用户有过对话才算订阅。entry 写固定名单里的那一条。",
    defaultReason: "在设置页取消了一个固定订阅",
    available: (target) => (target.pinned.length ? AVAILABLE : unavailable("还没有固定订阅的对话")),
    run: (run) => {
      const { entry } = run.input as UiActionInputOf<"channel_subscriptions", "unpin">;
      return service(run.env).unpin(run.target.source, entry);
    },
    forLead: (_run, result) => result,
    detail: (run) => ({ entry: (run.input as { entry: string }).entry }),
  },
} satisfies Record<string, UiActionDefinition<ChannelSubscriptionsState, any>>;
