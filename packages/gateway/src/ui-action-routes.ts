// 工单以外的操作的页面入口（仓库 AGENTS.md「UI Actions」）。实现在 engine 的 ui-actions/，这里只把原来的路由接过去：
// 原来的路由（/v1/runtimes/settings、/v1/admin/bindings/:id/revoke……）照旧认证、校验请求体，然后调 performUserUiAction，
// 以你本人的名义执行。请求体里没有「谁做的」：Lead 走自己的工具（packages/lead 的 perform_action）。
import type { OwnerActionSource, Scope } from "@pi-lead-child/protocol";
import type { Binding, Db } from "@pi-lead-child/store";
import {
  UiActionError, runUiAction, uiActionDefinition,
  type UiActionOutcome, type UiActionServices, type UiActionTarget,
} from "@pi-lead-child/engine";

export interface UserUiActionContext {
  db: Db;
  services: UiActionServices;
  log(line: string): void;
}

/**
 * 以你的名义执行一个工单以外的操作。binding 和 source 用来记账本和主人操作（「不是我」作废的就是这个凭证）。
 * scopes 是这个凭证的 scope（网关的 requireAuth 给的）：要有这个操作的定义里写的 scope，否则拒绝。路由自己也查一遍，
 * 这里再查一次，免得路由要的 scope 和定义里的不一样。
 */
export function performUserUiAction(
  ctx: UserUiActionContext,
  request: {
    target: UiActionTarget; action: string; input?: unknown; reason?: string | null;
    binding: Binding; scopes: readonly Scope[]; source: OwnerActionSource;
  },
): Promise<UiActionOutcome> {
  const definition = uiActionDefinition(request.target.type, request.action);
  if (definition && !request.scopes.includes(definition.scope)) {
    return Promise.reject(new UiActionError("forbidden", `${definition.label}要 ${definition.scope} 权限，这个凭证没有`));
  }
  return runUiAction(ctx.db, {
    target: request.target,
    action: request.action,
    ...(request.input !== undefined ? { input: request.input } : {}),
    ...(request.reason ? { reason: request.reason } : {}),
    caller: { kind: "user", credential: request.binding, source: request.source },
    services: ctx.services,
    log: ctx.log,
  });
}
