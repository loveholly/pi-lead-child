// 用户控制面的动作（spec §6.4/§8）。这里的每个动作都以你（actor='user'）的名义落笔。
//
// §6.4 里 draft→ready、ready→draft、active→ready、review→done、done→active、cancelled→draft、以及 Run 的 pause/resume
// 都只属于 user。它们的实现在 engine 的 ticket-actions/lifecycle.ts（工单操作层，spec 5.11）：同一份实现，
// 页面经 HTTP 以你的名义调，Lead 只能在你这一轮里代你调，账本写「Lead 代你做」（actor=lead，onBehalfOf=user），
// 不写成你本人做的。
// 页面和 plc 的这些操作都走 HTTP 路由（plc 经 packages/client 调同样的路由），路由转调操作层（engine 的 runTicketAction、
// runUiAction，ui-action-parity plan.md P03）。这里留给「不是我」的撤销：它调的是操作层背后的同一个函数，以你的名义，
// 不经过「现在能不能做」的检查（撤销要把状态改回去），也不记 ui_action.performed（撤销自己记在主人操作上）。
import { USER_ITEM_ACTION_IDS } from "@pi-lead-child/protocol";
import type { Db } from "@pi-lead-child/store";
import {
  BY_USER, cancelItem, completeItem, confirmItem, pauseItemRun, requestReview, restoreItem, resumeItemRun, reworkItem,
  startItem, stopItem, stopItemRun, unconfirmItem,
  type ItemRestoreMode, type ItemRestoreResult, type ResumeRunRequest, type ReviewRequestResult, type TicketActionHost,
} from "@pi-lead-child/engine";
import type { RuntimeId } from "@pi-lead-child/core";
import {
  itemUpdatedEvent,
  publishGatewayEvent,
  runUpdatedEvent,
  getRun,
  type PublishGatewayEventInput,
} from "@pi-lead-child/store";

export type { ResumeRunRequest, ReviewRequestResult } from "@pi-lead-child/engine";

// 宿主注入的东西（恢复、开始、核查员的选择）。和工单操作层是同一个 TicketActionHost：
// daemon 只建一份，交给这里和 Lead，两个入口拉起进程、选核查员的方式一样。
export interface UserActionDeps extends TicketActionHost {
  db: Db;
}

export interface UserActionService {
  // 建这个服务用的宿主。工单操作层的 HTTP 入口用同一份（paired-server 的 /v1/tickets/:id/actions）。
  readonly host: TicketActionHost;
  confirmItem(id: number): void;
  unconfirmItem(id: number): void;
  startItem(id: number): void;
  stopItem(id: number): Promise<void>;
  completeItem(id: number): void;
  // delegationPolicyId：这次返工是授权时顺带启动的，属于那份授权，计入 Lead 的返工额度。
  // 用户自己点的手动返工不带它，不占额度。
  reworkItem(id: number, reason?: string, options?: { delegationPolicyId?: number }): void;
  // 不是 stage 的一条边：工单停在 review，只是给最新的交付排一次独立核查（工单 #66）。
  // runtime：用户选的核查员（2026-10-20）。给了就走 engine 的 changeReviewer：有排着的核查就改它，没有就新排一条。
  requestReview(id: number, options?: { runtime?: RuntimeId }): ReviewRequestResult;
  cancelItem(id: number, reason?: string): Promise<void>;
  restoreItem(id: number, options?: {
    mode?: ItemRestoreMode;
    childItemIds?: number[];
    requestedBy?: string;
    sourceTurnId?: string | null;
  }): Promise<ItemRestoreResult | void>;
  pauseRun(runId: number, at?: Date): Promise<void>;
  resumeRun(runId: number, at?: Date): Promise<void>;
  stopRun(runId: number, reason?: string): Promise<void>;
}

export function createUserActionService(deps: UserActionDeps): UserActionService {
  const { db, ...host } = deps;

  const actions: Omit<UserActionService, "host"> = {
    confirmItem(id) {
      confirmItem(db, id, BY_USER);
    },

    unconfirmItem(id) {
      unconfirmItem(db, id, BY_USER);
    },

    startItem(id) {
      startItem(db, host, id, BY_USER);
    },

    async stopItem(id) {
      // 手动停下（spec §6.1 的 active → ready），并终止在跑的 Run。
      await stopItem(db, id, "stopped by user", BY_USER);
    },

    completeItem(id) {
      completeItem(db, id, BY_USER);
    },

    reworkItem(id, reason = "rework requested by user", options = {}) {
      reworkItem(db, id, reason, BY_USER, options);
    },

    requestReview(id, options = {}) {
      return requestReview(db, host, id, BY_USER, options);
    },

    async cancelItem(id, reason = "cancelled by user") {
      await cancelItem(db, id, reason, BY_USER);
    },

    async restoreItem(id, options = {}) {
      // reminder 的状态机里没有 draft（§6.2）：engine 的 restoreItem 把提醒恢复到 scheduled。
      return restoreItem(db, id, BY_USER, {
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.childItemIds ? { childItemIds: options.childItemIds } : {}),
        requestedBy: options.requestedBy ?? "user via control plane",
      }) ?? undefined;
    },


    pauseRun(runId, at = new Date()) {
      return pauseItemRun(db, runId, BY_USER, at);
    },

    resumeRun(runId, at = new Date()) {
      return resumeItemRun(db, host, runId, BY_USER, at);
    },

    stopRun(runId, reason = "stopped by user") {
      return stopItemRun(db, runId, reason, BY_USER);
    },
  };

  // 每个成功的动作发一条"重拉快照"的线上事件。用户动作有好几个入口：paired HTTP、
  // daemon socket 上的 plc CLI、委托返工。它们共用这一个实例，所以事件只在这里发。
  // 入口各发各的，就会有入口漏发：10-12 的 plc item complete 改了工单，却没写 gateway_events，
  // companion 一直停在"待验收"，直到刷新。被拒的动作什么都没改，所以不发。
  const announce = <A extends [number, ...unknown[]], R>(
    act: (...args: A) => R,
    event: (id: number) => PublishGatewayEventInput | null,
  ) => (...args: A): R => {
    const publish = () => {
      const input = event(args[0]);
      if (input) publishGatewayEvent(db, input);
    };
    const result = act(...args);
    // 同步动作保持同步：调用方依赖同步抛出的错误。
    if (result instanceof Promise) return result.then((value) => { publish(); return value; }) as R;
    publish();
    return result;
  };
  const runEvent = (runId: number) => {
    const run = getRun(db, runId);
    return run ? runUpdatedEvent(run.item_id, runId) : null;
  };

  return {
    host,
    confirmItem: announce(actions.confirmItem, itemUpdatedEvent),
    unconfirmItem: announce(actions.unconfirmItem, itemUpdatedEvent),
    startItem: announce(actions.startItem, itemUpdatedEvent),
    stopItem: announce(actions.stopItem, itemUpdatedEvent),
    completeItem: announce(actions.completeItem, itemUpdatedEvent),
    reworkItem: announce(actions.reworkItem, itemUpdatedEvent),
    requestReview: announce(actions.requestReview, itemUpdatedEvent),
    cancelItem: announce(actions.cancelItem, itemUpdatedEvent),
    restoreItem: announce(actions.restoreItem, itemUpdatedEvent),
    pauseRun: announce(actions.pauseRun, runEvent),
    resumeRun: announce(actions.resumeRun, runEvent),
    stopRun: announce(actions.stopRun, runEvent),
  };
}

// 用户能做的事项动作名。名单来自 protocol：companion 的动作行按同一份名单渲染按钮，
// 网关的路由（paired-server 的 ITEM_ACTIONS）也按同一份名单放行。
// 两边各抄一份，就会出现"UI 有按钮、服务端 404"或者反过来。
export const USER_ITEM_ACTIONS = USER_ITEM_ACTION_IDS;
export const USER_RUN_ACTIONS = ["pause", "resume", "stop"] as const;
export type UserItemAction = typeof USER_ITEM_ACTIONS[number];
export type UserRunAction = typeof USER_RUN_ACTIONS[number];
