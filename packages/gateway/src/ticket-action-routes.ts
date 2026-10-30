// 工单操作的页面入口（spec 5.11）。实现在 engine 的 ticket-actions/，这里只做认证、请求体校验和错误映射。
//   - GET  /v1/tickets/:id/actions          tickets:view：每个操作现在能不能做、为什么。只在本机生效的操作（打开文件）
//     按请求是不是从回环地址来算。
//   - POST /v1/tickets/:id/actions/:action  每个操作自己的 scope：执行。请求体 { input?, reason? }。
// 页面入口一律以你本人的名义：请求体里没有「谁做的」，Lead 走自己的工具（packages/lead 的 ticket_action）。
// 旧的路由（/confirm、/complete、/rework、/cancel、/request-review、/relations、/delivery/merge、/runs/:id/pause……）
// 在 paired-server.ts 里转调 performUserTicketAction，所以它们和新路由做同样的检查，记同样的账本。
import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "typebox/value";
import { TicketActionRunRequestSchema, type OwnerActionSource, type Scope } from "@pi-lead-child/protocol";
import type { Binding, Db } from "@pi-lead-child/store";
import {
  listTicketActions, runTicketAction, ticketActionDefinition,
  type PullRequestRunner, type TicketActionHost, type TicketActionOutcome,
} from "@pi-lead-child/engine";

export interface UserTicketActionContext {
  db: Db;
  host: TicketActionHost;
  pullRequestRunner?: PullRequestRunner;
  log(line: string): void;
}

/** 以你的名义执行一个工单操作。binding 和 source 用来记主人操作（「不是我」作废的就是这个凭证）。 */
export function performUserTicketAction(
  ctx: UserTicketActionContext,
  request: {
    itemId: number; action: string; input?: unknown; reason?: string | null;
    binding: Binding; source: OwnerActionSource;
  },
): Promise<TicketActionOutcome> {
  return runTicketAction(ctx.db, {
    itemId: request.itemId,
    action: request.action,
    ...(request.input !== undefined ? { input: request.input } : {}),
    ...(request.reason ? { reason: request.reason } : {}),
    caller: { kind: "user", credential: request.binding, source: request.source },
    host: ctx.host,
    ...(ctx.pullRequestRunner ? { pullRequestRunner: ctx.pullRequestRunner } : {}),
    log: ctx.log,
  });
}

export interface TicketActionRouteContext extends UserTicketActionContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  json(status: number, value: unknown): void;
  readBody(): Promise<unknown>;
  requireAuth(scope: Scope): Binding;
  requestSource(binding: Binding): OwnerActionSource;
  // 操作以后的 TicketSummary（读不到时为 null）。
  ticket(itemId: number): unknown;
  // 把这次操作写进 outbox 的线上事件立刻推出去：客户端先收到事件，再收到响应。
  flush(): void;
  // 把错误映射成 HTTP 错误（TicketActionError、DeliveryError、状态机的错……）。
  mapError(error: unknown): never;
  // 请求体不对。
  invalid(message: string): never;
}

const LIST_PATH = /^\/v1\/tickets\/(\d+)\/actions$/;
const RUN_PATH = /^\/v1\/tickets\/(\d+)\/actions\/([a-z_]+)$/;

// 处理了返回 true；不是这两条路由返回 false。
export async function handleTicketActionRoute(ctx: TicketActionRouteContext): Promise<boolean> {
  const { req, url } = ctx;
  const listMatch = req.method === "GET" ? url.pathname.match(LIST_PATH) : null;
  const runMatch = req.method === "POST" ? url.pathname.match(RUN_PATH) : null;
  if (!listMatch && !runMatch) return false;
  try {
    if (listMatch) {
      const binding = ctx.requireAuth("tickets:view");
      const ticketId = Number(listMatch[1]);
      // 只在本机生效的操作（打开文件）：手机上看清单时显示为不能做。和执行时一样，按 socket 是不是回环地址判断。
      const local = ctx.requestSource(binding).loopback;
      ctx.json(200, { ticketId, actions: await listTicketActions(ctx.db, ticketId, { host: ctx.host, local }) });
      return true;
    }
    const ticketId = Number(runMatch![1]);
    const action = runMatch![2]!;
    const definition = ticketActionDefinition(action);
    // 不认识的操作先要求能写工单的 scope，再说没有：不给只读的凭证探测操作清单。
    const binding = ctx.requireAuth(definition?.scope ?? "tickets:create");
    const body = req.headers["content-length"] === "0" ? {} : (await ctx.readBody()) ?? {};
    if (!Value.Check(TicketActionRunRequestSchema, body)) {
      ctx.invalid("body must be { input?: object, reason?: string }");
    }
    const { input, reason } = body as { input?: Record<string, unknown>; reason?: string };
    const outcome = await performUserTicketAction(ctx, {
      itemId: ticketId, action, ...(input !== undefined ? { input } : {}), ...(reason ? { reason } : {}),
      binding, source: ctx.requestSource(binding),
    });
    ctx.flush();
    ctx.json(200, { ticketId, action: outcome.action, result: outcome.result, ticket: ctx.ticket(ticketId) });
    return true;
  } catch (error) {
    ctx.mapError(error);
  }
}
