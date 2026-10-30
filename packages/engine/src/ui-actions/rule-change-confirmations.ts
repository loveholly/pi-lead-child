// 改规则被拦下以后的一次性确认卡（统一的消息事件 spec D10 的「放行」，工单 09；用户 2026-10-27 定的缺省做法）。
// 契约和事件在 protocol 的 rule-change-confirmations.ts。
//
// 外部的一轮里改规则的操作被拒绝时（external-content.ts，工单 07），requestRuleChangeConfirmation 存下这一个操作（参数原样），
// 拒绝里带着确认卡的 user_action。Lead 把它原样放进 UserAction 卡，卡上的内容都从这里读，Lead 改不了。
// 用户在卡上点「确认这一次」或「不改」，是操作层的 rule_change.resolve（权限 user_direct，Lead 调它总是被拒绝）：
//   - 确认：先记下决定（同一张卡只执行一次），再执行存下的那一个操作，参数不能换。UI 动作走 runUiAction，
//     调用方是「Lead 凭这张确认卡代用户做」（index.ts 的 confirmedAuthority 只认卡上存下的操作）；还没登记成 UI 动作的
//     改常设指令照存下的参数调同一个提议函数，分档照旧（更放开的仍然要用户批准）。账本记成 Lead 代用户做、用户确认过。
//   - 不改：记下来。
// 两种结果都写一条 inbox 叫醒 Lead（Lead 在等这张卡时，等待按同一个对象键认出这一条已经叫醒了它）。
// 确认只放开「外部内容」这一道闸，不放宽别的：Lead 本来不能做的（只收紧的授权表遇到放宽）照样被拒绝。
// 有范围的临时授权以后再做。
import { randomBytes } from "node:crypto";
import {
  RULE_CHANGE_CONFIRMATION_ID, RULE_CHANGE_CONFIRMATION_LIMITS, RULE_CHANGE_CONFIRMATION_TTL_MS,
  RULE_CHANGE_EXECUTED_KIND, RULE_CHANGE_REQUESTED_KIND, RULE_CHANGE_RESOLVED_KIND, STANDING_ORDER_CHANGE_OPS,
  userActionRequest,
  type RuleChangeConfirmationDto, type RuleChangeConfirmationState, type RuleChangeDecision, type Scope, type StandingOrderChangeOp,
  type UiActionInputOf, type UserActionRequest,
} from "@pi-lead-child/protocol";
import {
  addInbox, appendEvent, bindingScopes, getBinding, listEvents, proposeStandingOrderChange, StandingOrderChangeError,
  STANDING_ORDER_PROPOSAL_TTL_MS,
  type Binding, type Db, type EventRecord, type StandingOrderChangeRequest, type StandingOrderPatch,
} from "@pi-lead-child/store";
import { AVAILABLE, unavailable } from "../ticket-actions/types.js";
import type { ExternalContentSource, RuleChangeConfirm, RuleChangeOperation } from "./external-content.js";
import { UiActionError, type UiActionDefinition, type UiActionRun, type UiActionServices, type UiActionTargetKind } from "./types.js";
import { hostCommandInputOf, runHostCommand } from "./host-commands.js";

export const ruleChangeEntityKey = (id: string) => `rule_change:${id}`;

// 卡上的按钮字，也是 user_action 的 title。
const CONFIRM_TITLE = "确认这一次";

// 存下的那一份：rule_change.requested 的 payload。
interface StoredRequest {
  id: string;
  operation: RuleChangeOperation;
  label: string;
  name: string | null;
  where: string;
  reason: string;
  why: string;
  externalContent: ExternalContentSource[];
  expiresAt: string;
}

interface StoredResolution { decision: RuleChangeDecision; resolvedBy: string; bindingId: number | null }
interface StoredExecution { state: "done" | "failed"; result: string }

interface RuleChangeRecord {
  request: StoredRequest;
  createdAt: string;
  resolution: (StoredResolution & { at: string }) | null;
  execution: (StoredExecution & { at: string }) | null;
}

// 键按字母排的 JSON：比较两份参数时不看键的顺序。
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : item)) ?? "null";
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function recordOf(db: Db, id: string): RuleChangeRecord | null {
  if (!RULE_CHANGE_CONFIRMATION_ID.test(id)) return null;
  const events = listEvents(db, {
    entityKey: ruleChangeEntityKey(id), kind: [RULE_CHANGE_REQUESTED_KIND, RULE_CHANGE_RESOLVED_KIND, RULE_CHANGE_EXECUTED_KIND], limit: 10,
  });
  const first = (kind: string): EventRecord | undefined => events.find((event) => event.kind === kind);
  const requested = first(RULE_CHANGE_REQUESTED_KIND);
  if (!requested) return null;
  const resolved = first(RULE_CHANGE_RESOLVED_KIND);
  const executed = first(RULE_CHANGE_EXECUTED_KIND);
  return {
    request: requested.payload as unknown as StoredRequest,
    createdAt: requested.occurredAt,
    resolution: resolved ? { ...(resolved.payload as unknown as StoredResolution), at: resolved.occurredAt } : null,
    execution: executed ? { ...(executed.payload as unknown as StoredExecution), at: executed.occurredAt } : null,
  };
}

function stateOf(record: RuleChangeRecord, now: Date): RuleChangeConfirmationState {
  if (record.execution) return record.execution.state;
  if (record.resolution) return record.resolution.decision === "decline" ? "declined" : "running";
  return now.getTime() >= Date.parse(record.request.expiresAt) ? "expired" : "pending";
}

// 卡上的参数：输入的每一项一行，值是 JSON（字符串原样），长的截断。
function paramsOf(input: unknown): Array<{ name: string; value: string }> {
  const entries = input && typeof input === "object" && !Array.isArray(input)
    ? Object.entries(input as Record<string, unknown>).filter(([, value]) => value !== undefined)
    : [["input", input] as const];
  return entries.slice(0, RULE_CHANGE_CONFIRMATION_LIMITS.params).map(([name, value]) => ({
    name, value: clip(typeof value === "string" ? value : sortedJson(value), RULE_CHANGE_CONFIRMATION_LIMITS.value),
  }));
}

function dtoOf(record: RuleChangeRecord, now: Date): RuleChangeConfirmationDto {
  const { request } = record;
  const operation = request.operation.kind === "ui_action"
    ? { kind: "ui_action" as const, target: { type: request.operation.target.type, id: request.operation.target.id }, action: request.operation.action }
    : { kind: "lead_tool" as const, tool: request.operation.tool };
  return {
    id: request.id,
    state: stateOf(record, now),
    label: request.label,
    name: request.name,
    operation,
    params: paramsOf(request.operation.input),
    reason: request.reason,
    why: request.why,
    externalContent: request.externalContent,
    where: request.where,
    createdAt: record.createdAt,
    expiresAt: request.expiresAt,
    resolvedAt: record.resolution?.at ?? null,
    resolvedBy: record.resolution?.resolvedBy ?? null,
    resultPreview: record.execution ? clip(record.execution.result, 500) : null,
  };
}

/** 一张确认卡现在的样子（卡和网关读它）。没有这张卡时为 null。 */
export function getRuleChangeConfirmation(db: Db, id: string, now: Date = new Date()): RuleChangeConfirmationDto | null {
  const record = recordOf(db, id);
  return record ? dtoOf(record, now) : null;
}

export interface RuleChangeConfirmationRequest {
  confirm: RuleChangeConfirm;
  // 操作的名字（「收紧自动代你处理」），改的是哪个对象（「slack 的自动代你处理」，没有时为 null），用户自己去哪里改。
  label: string;
  name: string | null;
  where: string;
  now?: Date;
}

/**
 * 存下一个被拦下的改规则操作，返回确认号和确认卡的 user_action。同一个操作（参数一样）已经有一张没决定的卡时，用那一张，
 * 不再存一份：Lead 被拒以后再试一次，用户也只看到一张卡。
 */
export function requestRuleChangeConfirmation(db: Db, request: RuleChangeConfirmationRequest): { id: string; userAction: UserActionRequest } {
  const now = request.now ?? new Date();
  const operation = sortedJson(request.confirm.operation);
  const id = db.transaction((): string => {
    const known = listEvents(db, { kind: RULE_CHANGE_REQUESTED_KIND, order: "desc", limit: 50 })
      .map((event) => recordOf(db, String(event.payload.id)))
      .find((record) => record && stateOf(record, now) === "pending" && sortedJson(record.request.operation) === operation);
    if (known) return known.request.id;
    const fresh = `rcc_${randomBytes(12).toString("base64url")}`;
    const payload: StoredRequest = {
      id: fresh, operation: request.confirm.operation, label: request.label, name: request.name, where: request.where,
      reason: request.confirm.reason, why: request.confirm.why, externalContent: [...request.confirm.externalContent],
      expiresAt: new Date(now.getTime() + RULE_CHANGE_CONFIRMATION_TTL_MS).toISOString(),
    };
    appendEvent(db, {
      source: "system", kind: RULE_CHANGE_REQUESTED_KIND, entityKey: ruleChangeEntityKey(fresh), level: "record",
      payload: payload as unknown as Record<string, unknown>, occurredAt: now.toISOString(),
    });
    return fresh;
  })();
  return {
    id,
    userAction: userActionRequest({
      kind: "confirm_rule_change", target: ruleChangeEntityKey(id), title: CONFIRM_TITLE,
      reason: request.confirm.reason.trim() || request.label,
    }),
  };
}

/**
 * 执行用的那条路（Lead 凭这张确认卡代用户做）：卡已经确认、还没执行，操作和参数和卡上存下的一样，点它的是同一台设备。
 * 是时返回 null，不是时返回原因。
 */
export function confirmedOperationProblem(
  db: Db, confirmation: { id: string; bindingId: number }, operation: Extract<RuleChangeOperation, { kind: "ui_action" }>,
): string | null {
  const record = recordOf(db, confirmation.id);
  if (!record) return `没有确认卡 ${confirmation.id}`;
  if (record.execution || record.resolution?.decision !== "confirm") return `确认卡 ${confirmation.id} 还没有确认，或者已经执行过了`;
  if (record.resolution.bindingId !== confirmation.bindingId) return `确认卡 ${confirmation.id} 不是这台设备确认的`;
  if (sortedJson(record.request.operation) !== sortedJson(operation)) return `这个操作和确认卡 ${confirmation.id} 上存下的不一样`;
  return null;
}

// ── 改常设指令（还没登记成 UI 动作的 Lead 工具，packages/lead 的 standing-order-tools.ts）─────────────────

/** propose_standing_order_change 的参数（去掉 reason）换成提议函数的请求。Lead 的工具和确认卡用同一个函数。 */
export function standingOrderChangeRequestOf(input: Record<string, unknown>, reason: string): StandingOrderChangeRequest {
  const op = input.op as StandingOrderChangeOp;
  if (!(STANDING_ORDER_CHANGE_OPS as readonly string[]).includes(String(op)) || typeof input.id !== "string") {
    throw new StandingOrderChangeError("invalid_request", "要有 op 和 id");
  }
  const patch: StandingOrderPatch = {
    ...(input.title !== undefined ? { title: input.title as string } : {}),
    ...(input.priority !== undefined ? { priority: input.priority as number } : {}),
    ...(input.condition !== undefined ? { condition: input.condition as StandingOrderPatch["condition"] } : {}),
    ...(input.action !== undefined ? { action: input.action as StandingOrderPatch["action"] } : {}),
    ...(input.limits !== undefined ? { limits: input.limits as StandingOrderPatch["limits"] } : {}),
    ...(input.escalate_to !== undefined ? { escalateTo: input.escalate_to as StandingOrderPatch["escalateTo"] } : {}),
  };
  return { op, id: input.id, reason, patch, ...(input.to_version !== undefined ? { toVersion: input.to_version as number } : {}) };
}

// 确认以后执行存下的操作时手边有的：确认的那台设备、操作层的服务、确认卡的编号。
interface StoredOperationContext {
  binding: Binding;
  services: UiActionServices;
  id: string;
}

// 还没登记成 UI 动作的工具：执行要的 scope（和设置页上改它的路由一样）和执行。
//   - propose_standing_order_change：改常设指令（外部内容的一轮里被拦下的改规则）。
//   - ticket_action：Lead 被拦下的工单操作（2026-10-29 兜底授权卡）。确认以后按用户本人的操作执行，凭的是确认的设备。
//   - run_on_host：在用户的 Mac 上、沙箱外跑一条命令（host-commands.ts，2026-10-29 兜底授权卡）。
const LEAD_TOOL_OPERATIONS: Readonly<Record<string, {
  scope: Scope;
  run(db: Db, input: unknown, reason: string, now: Date, context: StoredOperationContext): Promise<{ text: string; next?: string }> | { text: string; next?: string };
}>> = {
  ticket_action: {
    scope: "tickets:create",
    async run(db, input, reason, _now, context) {
      const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
      const itemId = typeof raw.ticket_id === "number" ? raw.ticket_id : NaN;
      const action = typeof raw.action === "string" ? raw.action : "";
      if (!Number.isSafeInteger(itemId) || !action) throw new UiActionError("invalid_input", "存下的参数不对：要有 ticket_id 和 action");
      const host = context.services.ticketActions;
      if (!host) throw new UiActionError("unavailable", "工单操作的服务还没有启动");
      const { runTicketAction } = await import("../ticket-actions/index.js");
      const outcome = await runTicketAction(db, {
        itemId, action, ...(raw.input !== undefined ? { input: raw.input } : {}), reason,
        caller: {
          kind: "user", credential: context.binding,
          source: { client: "web", deviceName: context.binding.display_name, loopback: false, fromThisMachine: false },
        },
        host: host.host,
        ...(host.pullRequestRunner ? { pullRequestRunner: host.pullRequestRunner } : {}),
      });
      return { text: `已经执行：工单 #${itemId} 的 ${action}。${clip(sortedJson(outcome.result ?? null), 300)}` };
    },
  },
  run_on_host: {
    scope: "tickets:create",
    async run(_db, input, _reason, _now, context) {
      const result = await runHostCommand(hostCommandInputOf(input), { id: context.id });
      return { text: result.text, next: `命令的完整输出在 ${result.outputPath}，用 read 读。` };
    },
  },
  propose_standing_order_change: {
    scope: "tickets:create",
    run(db, input, reason, now) {
      if (!input || typeof input !== "object") throw new UiActionError("invalid_input", "存下的参数不对");
      const request = standingOrderChangeRequestOf(input as Record<string, unknown>, reason);
      let result;
      try {
        result = proposeStandingOrderChange(db, request, { now });
      } catch (error) {
        if (error instanceof StandingOrderChangeError) throw new UiActionError("invalid_input", error.message);
        throw error;
      }
      if (result.outcome === "unchanged") throw new UiActionError("unavailable", `常设指令 ${request.id} 的新内容和现在的版本一样，没有改`);
      if (result.outcome === "refused") {
        throw new UiActionError("forbidden", `碰到硬性安全规则，没有改：${result.plan.classification.findings.map((item) => item.detail).join("；")}`);
      }
      if (result.outcome === "applied") return { text: `已经生效：常设指令 ${request.id} 第 ${result.written.order.version} 版` };
      // 更放开的修改仍然要用户批准（分档照旧）：确认卡只放开了外部内容这一道闸。
      return {
        text: `这项修改更放开，还要你批准：常设指令的确认卡（审批 #${result.proposal.approvalId}），`
          + `${STANDING_ORDER_PROPOSAL_TTL_MS / 3_600_000} 小时内有效`,
        next: `用 render_ui 发一张 StandingOrderChangeConfirm 卡（approval 填 ${result.proposal.approvalId}），请用户批准。`,
      };
    },
  },
};

// ── 操作层的目标和操作 ─────────────────────────────────────────────────────────────

export interface RuleChangeTarget {
  confirmation: RuleChangeConfirmationDto;
  operation: RuleChangeOperation;
}

export const RULE_CHANGE_TARGET: UiActionTargetKind<RuleChangeTarget> = {
  type: "rule_change",
  label: "改规则的确认卡",
  idHint: "确认号，rcc_ 开头",
  load(env, id) {
    const record = recordOf(env.db, id);
    return record ? { confirmation: dtoOf(record, env.now), operation: record.request.operation } : null;
  },
  name: (target) => `改规则的确认卡（${target.confirmation.label}）`,
  describe: (target) => ({
    id: target.confirmation.id, state: target.confirmation.state, label: target.confirmation.label, name: target.confirmation.name,
    operation: target.confirmation.operation, params: target.confirmation.params, why: target.confirmation.why,
    expiresAt: target.confirmation.expiresAt, resultPreview: target.confirmation.resultPreview,
  }),
};

const STATE_WORDS: Record<Exclude<RuleChangeConfirmationState, "pending">, string> = {
  running: "这张确认卡已经确认了，正在执行",
  done: "这张确认卡已经确认并执行过了",
  failed: "这张确认卡已经确认过了，执行失败了",
  declined: "这张确认卡已经点了「不改」",
  expired: "这张确认卡已经过期作废了",
};

// index.ts 也 import 这个文件（经过清单），所以 runUiAction 和操作的定义按需取，不在模块顶层互相引用。
const operationLayer = () => import("./index.js");

async function operationScope(operation: RuleChangeOperation): Promise<Scope | null> {
  if (operation.kind === "lead_tool") return LEAD_TOOL_OPERATIONS[operation.tool]?.scope ?? null;
  const { uiActionDefinition } = await operationLayer();
  return uiActionDefinition(operation.target.type, operation.action)?.scope ?? null;
}

function resolvedByOf(binding: Binding | null): string {
  return binding ? `user via ${binding.display_name}（binding ${binding.id}）` : "user via page";
}

function resultText(value: unknown): string {
  const order = value && typeof value === "object" ? (value as { order?: { id?: unknown; version?: unknown } }).order : undefined;
  if (order && typeof order.id === "string" && typeof order.version === "number") return `已经生效：常设指令 ${order.id} 第 ${order.version} 版`;
  return `已经执行：${clip(sortedJson(value), 400)}`;
}

async function executeStored(
  run: UiActionRun<RuleChangeTarget, UiActionInputOf<"rule_change", "resolve">>, binding: Binding,
): Promise<{ text: string; next?: string }> {
  const { operation, confirmation } = run.target;
  if (operation.kind === "lead_tool") {
    const known = LEAD_TOOL_OPERATIONS[operation.tool];
    if (!known) throw new UiActionError("unavailable", `不认识存下的操作 ${operation.tool}`);
    return await known.run(run.db, operation.input, confirmation.reason, run.env.now, {
      binding, services: run.env.services ?? {}, id: confirmation.id,
    });
  }
  const { runUiAction } = await operationLayer();
  const outcome = await runUiAction(run.db, {
    target: operation.target,
    action: operation.action,
    input: operation.input,
    reason: confirmation.reason,
    caller: { kind: "lead", turnId: null, confirmation: { id: confirmation.id, bindingId: binding.id } },
    services: run.env.services,
    now: run.env.now,
  });
  return { text: resultText(outcome.forLead) };
}

function tellLead(db: Db, confirmation: RuleChangeConfirmationDto, next?: string): void {
  const what = `${confirmation.label}${confirmation.name ? `（${confirmation.name}）` : ""}`;
  const summary = confirmation.state === "declined"
    ? `用户在确认卡上点了「不改」：${what}。不要再做这件事，也不要换别的办法去改。`
    : confirmation.state === "done"
    ? `用户在确认卡上确认了，已经执行：${what}。结果：${confirmation.resultPreview ?? ""}${next ? `。${next}` : ""}`
    : `用户在确认卡上确认了，但执行失败：${what}。原因：${confirmation.resultPreview ?? "未知"}`;
  addInbox(db, {
    // 对象键和确认卡一样（rule_change:<编号>）：Lead 在等这张卡时，等待按它认出这一条已经叫醒了 Lead（lead-waits.ts）。
    dedupScope: ruleChangeEntityKey(confirmation.id), severity: "attention", source: "structural", lossless: true, summary,
    payload: { kind: "rule_change", confirmation: confirmation.id, state: confirmation.state, wakeLead: true, needsUser: false },
  });
}

async function resolveRuleChange(
  run: UiActionRun<RuleChangeTarget, UiActionInputOf<"rule_change", "resolve">>,
): Promise<{ confirmation: RuleChangeConfirmationDto }> {
  const { db, env } = run;
  const id = run.target.confirmation.id;
  const decision = run.input.decision;
  const binding = run.bindingId === null ? null : getBinding(db, run.bindingId);
  if (decision === "confirm") {
    // 账本要记下是哪台设备确认的（「不是我」作废的就是它）；Lead 代做的权限不能大过这台设备的凭证。
    if (!binding) throw new UiActionError("forbidden", "要在配对过的设备上确认：账本要记下是哪台设备点的");
    const scope = await operationScope(run.target.operation);
    if (scope && !bindingScopes(binding).includes(scope)) {
      throw new UiActionError("forbidden", `${run.target.confirmation.label}要 ${scope} 权限，这台设备的凭证没有`);
    }
  }
  // 先记下决定，再执行：同一张卡只执行一次（两次点击同时到，第二次在这里被挡下）。
  db.transaction(() => {
    const record = recordOf(db, id);
    const state = record ? stateOf(record, env.now) : "expired";
    if (state !== "pending") throw new UiActionError("unavailable", `${STATE_WORDS[state]}。`);
    appendEvent(db, {
      source: "system", kind: RULE_CHANGE_RESOLVED_KIND, entityKey: ruleChangeEntityKey(id), level: "record",
      payload: { id, decision, actor: "user", resolvedBy: resolvedByOf(binding), bindingId: binding?.id ?? null },
      occurredAt: env.now.toISOString(),
    });
  })();
  if (decision === "decline") {
    const declined = getRuleChangeConfirmation(db, id, env.now)!;
    tellLead(db, declined);
    return { confirmation: declined };
  }
  let execution: StoredExecution;
  let next: string | undefined;
  try {
    const done = await executeStored(run, binding!);
    execution = { state: "done", result: done.text };
    next = done.next;
  } catch (error) {
    execution = { state: "failed", result: error instanceof Error ? error.message : String(error) };
  }
  db.transaction(() => appendEvent(db, {
    source: "system", kind: RULE_CHANGE_EXECUTED_KIND, entityKey: ruleChangeEntityKey(id), level: "record",
    payload: {
      id, operation: run.target.operation, actor: "lead", onBehalfOf: "user", sourceTurnId: ruleChangeEntityKey(id),
      bindingId: binding!.id, state: execution.state, result: clip(execution.result, 2_000),
    },
    occurredAt: env.now.toISOString(),
  }))();
  const confirmation = getRuleChangeConfirmation(db, id, env.now)!;
  tellLead(db, confirmation, next);
  return { confirmation };
}

export const RULE_CHANGE_ACTIONS = {
  resolve: {
    target: "rule_change", id: "resolve", label: "在确认卡上决定改不改规则", scope: "approvals:respond",
    // 放行 Lead 被拦下的操作是批准 Lead 自己的请求：只有用户本人能决定（AGENTS.md UI Actions）。「不改」也是用户的决定。
    permission: "user_direct",
    // 确认以后会改规则，但它是 user_direct，Lead 在哪一轮都做不了。
    changesRules: false, external: false, irreversible: false,
    where: "会话里的确认卡",
    hint: "改规则的操作被拦下以后（refusal.code=external_turn），用户在确认卡上点「确认这一次」或「不改」。"
      + "你不能替用户点：调用总是被拒绝。用户在会话里说「改吧」时，请他在卡上点，或者在他的这一轮里你重新做那个操作。",
    defaultReason: "在确认卡上决定",
    available: (target) => (target.confirmation.state === "pending"
      ? AVAILABLE
      : unavailable(`${STATE_WORDS[target.confirmation.state as Exclude<RuleChangeConfirmationState, "pending">]}。`)),
    run: (run) => resolveRuleChange(run as UiActionRun<RuleChangeTarget, UiActionInputOf<"rule_change", "resolve">>),
    forLead: (_run, result) => {
      const { confirmation } = result as { confirmation: RuleChangeConfirmationDto };
      return { confirmation: { id: confirmation.id, state: confirmation.state, resultPreview: confirmation.resultPreview } };
    },
    detail: (run, result) => ({
      decision: (run.input as { decision: RuleChangeDecision }).decision,
      state: (result as { confirmation: RuleChangeConfirmationDto }).confirmation.state,
      operation: run.target.confirmation.operation,
    }),
  },
} satisfies Record<string, UiActionDefinition<RuleChangeTarget, UiActionInputOf<"rule_change", "resolve">>>;
