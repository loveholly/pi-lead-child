// /v1/rule-changes 的路由（改规则被拦下以后的确认卡，统一的消息事件 spec D10 的放行，工单 09）。
//   - GET  /v1/rule-changes/:id          tickets:view       卡的内容和状态：要改什么、参数、为什么改、为什么被拦。
//   - POST /v1/rule-changes/:id/resolve  approvals:respond  你的决定：{ decision: confirm | decline }。
// 决定是操作层的 rule_change.resolve（engine 的 ui-actions/，权限 user_direct）：这里只认证、校验请求体，再以你本人的名义
// 交给 perform。Lead 调同一个操作总是被拒绝，它的工具也走不到这条路由。approvals:respond 只给能做用户决定的凭证（和审批一样）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "typebox/value";
import {
  RULE_CHANGE_CONFIRMATION_ID, ResolveRuleChangeConfirmationRequestSchema,
  type RuleChangeConfirmationDto, type RuleChangeDecision, type Scope,
} from "@pi-lead-child/protocol";
import type { Db } from "@pi-lead-child/store";
import { getRuleChangeConfirmation } from "@pi-lead-child/engine";

export interface RuleChangeRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  db: Db;
  json(status: number, value: unknown): void;
  readBody(): Promise<unknown>;
  requireAuth(scope: Scope): void;
  // 以你本人的名义做 rule_change.resolve，返回操作的结果（{ confirmation }）。出错时抛 HttpError（网关按错误码映射）。
  perform(id: string, decision: RuleChangeDecision): Promise<{ confirmation: RuleChangeConfirmationDto }>;
}

const PATH = /^\/v1\/rule-changes\/([^/]+)(\/resolve)?$/;

const fail = (ctx: RuleChangeRouteContext, status: number, code: string, message: string) => ctx.json(status, { error: { code, message } });

/** 处理确认卡的路由。不是这些路径时返回 false。 */
export async function handleRuleChangeRoute(ctx: RuleChangeRouteContext): Promise<boolean> {
  const match = PATH.exec(ctx.url.pathname);
  if (!match) return false;
  const id = decodeURIComponent(match[1]!);
  const resolve = match[2] === "/resolve";
  const method = ctx.req.method;
  if (!resolve && method === "GET") {
    ctx.requireAuth("tickets:view");
    if (!RULE_CHANGE_CONFIRMATION_ID.test(id)) {
      fail(ctx, 400, "invalid_request", "confirmation id is malformed");
      return true;
    }
    const confirmation = getRuleChangeConfirmation(ctx.db, id);
    if (!confirmation) {
      fail(ctx, 404, "not_found", `没有确认卡 ${id}`);
      return true;
    }
    ctx.json(200, { confirmation });
    return true;
  }
  if (resolve && method === "POST") {
    ctx.requireAuth("approvals:respond");
    if (!RULE_CHANGE_CONFIRMATION_ID.test(id)) {
      fail(ctx, 400, "invalid_request", "confirmation id is malformed");
      return true;
    }
    const body = await ctx.readBody();
    if (!Value.Check(ResolveRuleChangeConfirmationRequestSchema, body)) {
      fail(ctx, 400, "invalid_request", "body must be { decision: confirm | decline }");
      return true;
    }
    const { confirmation } = await ctx.perform(id, (body as { decision: RuleChangeDecision }).decision);
    ctx.json(200, { confirmation });
    return true;
  }
  return false;
}
