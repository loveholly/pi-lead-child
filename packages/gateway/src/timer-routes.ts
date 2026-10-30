// 定时器带着来源的路由（统一的消息事件 spec D16，工单 12）。
//   - GET  /v1/timers/external             tickets:view       提醒列表里外部的人要求设、还在等的定时器，写明谁要求的。
//   - GET  /v1/timers/watches              tickets:view       提醒列表里还在等的后台检查（所有来源），写明谁设的（.scratch/lead-watch）。
//   - POST /v1/timers/:ref/cancel          tickets:create     取消一个定时器（follow_up:12、reminder:5、trigger:3、watch:2）。
//   - GET  /v1/timer-requests/:id          tickets:view       确认卡的内容和状态：什么定时器、谁要求的、为什么问你。
//   - POST /v1/timer-requests/:id/resolve  approvals:respond  你的决定：{ decision: confirm | decline }。
// 取消和决定都是操作层的操作（engine 的 ui-actions/：timer.cancel、timer_request.resolve）：这里只认证、校验请求体，
// 再以你本人的名义交给 perform。Lead 走同一个操作（perform_action）；timer_request.resolve 是 user_direct，Lead 调它总是被拒绝。
import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "typebox/value";
import {
  ResolveTimerRequestSchema, TIMER_REQUEST_ID, parseTimerRef,
  type Scope, type TimerRequestDecision, type TimerRequestDto,
} from "@pi-lead-child/protocol";
import type { Db } from "@pi-lead-child/store";
import { getTimerRequest, listExternalTimers, listWatchTimers } from "@pi-lead-child/engine";

export interface TimerRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  db: Db;
  json(status: number, value: unknown): void;
  readBody(): Promise<unknown>;
  requireAuth(scope: Scope): void;
  // 以你本人的名义做一个定时器的操作，返回操作的结果。出错时抛 HttpError（网关按错误码映射）。
  perform(target: { type: "timer" | "timer_request"; id: string }, action: "cancel" | "resolve", input?: unknown): Promise<unknown>;
}

const LIST = "/v1/timers/external";
const WATCHES = "/v1/timers/watches";
const CANCEL = /^\/v1\/timers\/([^/]+)\/cancel$/;
const REQUEST = /^\/v1\/timer-requests\/([^/]+)(\/resolve)?$/;

const fail = (ctx: TimerRouteContext, status: number, code: string, message: string) => ctx.json(status, { error: { code, message } });

/** 处理定时器的路由。不是这些路径时返回 false。 */
export async function handleTimerRoute(ctx: TimerRouteContext): Promise<boolean> {
  const path = ctx.url.pathname;
  const method = ctx.req.method;
  if (path === LIST && method === "GET") {
    ctx.requireAuth("tickets:view");
    ctx.json(200, { timers: listExternalTimers(ctx.db) });
    return true;
  }
  if (path === WATCHES && method === "GET") {
    ctx.requireAuth("tickets:view");
    ctx.json(200, { watches: listWatchTimers(ctx.db) });
    return true;
  }
  const cancel = CANCEL.exec(path);
  if (cancel && method === "POST") {
    ctx.requireAuth("tickets:create");
    const ref = decodeURIComponent(cancel[1]!);
    if (!parseTimerRef(ref)) {
      fail(ctx, 400, "invalid_request", "timer ref must be follow_up:<id>, reminder:<id>, trigger:<id> or watch:<id>");
      return true;
    }
    ctx.json(200, { result: await ctx.perform({ type: "timer", id: ref }, "cancel") });
    return true;
  }
  const request = REQUEST.exec(path);
  if (!request) return false;
  const id = decodeURIComponent(request[1]!);
  const resolve = request[2] === "/resolve";
  if (!resolve && method === "GET") {
    ctx.requireAuth("tickets:view");
    if (!TIMER_REQUEST_ID.test(id)) {
      fail(ctx, 400, "invalid_request", "timer request id is malformed");
      return true;
    }
    const found = getTimerRequest(ctx.db, id);
    if (!found) {
      fail(ctx, 404, "not_found", `没有定时器的确认卡 ${id}`);
      return true;
    }
    ctx.json(200, { request: found });
    return true;
  }
  if (resolve && method === "POST") {
    ctx.requireAuth("approvals:respond");
    if (!TIMER_REQUEST_ID.test(id)) {
      fail(ctx, 400, "invalid_request", "timer request id is malformed");
      return true;
    }
    const body = await ctx.readBody();
    if (!Value.Check(ResolveTimerRequestSchema, body)) {
      fail(ctx, 400, "invalid_request", "body must be { decision: confirm | decline }");
      return true;
    }
    const result = await ctx.perform({ type: "timer_request", id }, "resolve", { decision: (body as { decision: TimerRequestDecision }).decision });
    ctx.json(200, { request: (result as { request: TimerRequestDto }).request });
    return true;
  }
  return false;
}
