import type { Db } from "@pi-lead-child/store";
import {
  pendingContinuationEvents,
  parseContinuationActions,
  parseContinuationContext,
  updateContinuationEventState,
  updateContinuationState,
  type ContinuationAction,
  type ContinuationContext,
  type ContinuationEventRow,
  type ContinuationRow,
} from "@pi-lead-child/store";
import { delegationAuthorityLabel, type DelegationPolicy } from "@pi-lead-child/store";
import { createItem, getItem } from "@pi-lead-child/store";
import { capabilityReadyForLeadUse, getCapability } from "@pi-lead-child/store";
import { addInbox, addNotification } from "@pi-lead-child/store";
import { listBlockingDependencies, linkTickets } from "@pi-lead-child/store";
import type { DispatchRequestInput } from "./dispatch.js";

export interface ContinuationRunnerResult {
  processed: number;
  waitingDependency: number;
  waitingCapability: number;
  failed: number;
}

type ContinuationStepResult = "advanced" | "waiting" | "retry" | "failed" | "blocked";

function ticketFromAction(
  context: ContinuationContext,
  action: { ticketKey?: string; ticketId?: number },
): number {
  if (action.ticketId !== undefined) return action.ticketId;
  if (action.ticketKey) {
    const id = context.createdTickets?.[action.ticketKey];
    if (id) return id;
  }
  throw new Error("continuation action cannot resolve ticket id");
}

function sourceTicketFromAction(
  context: ContinuationContext,
  action: { sourceTicketKey?: string; sourceTicketId?: number },
): number {
  if (action.sourceTicketId !== undefined) return action.sourceTicketId;
  if (action.sourceTicketKey) {
    const id = context.createdTickets?.[action.sourceTicketKey];
    if (id) return id;
  }
  throw new Error("continuation link_tickets cannot resolve source ticket id");
}

function parseEventPayload(event: ContinuationEventRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(event.payload || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function numberFrom(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function capabilityIdFromEvent(event: ContinuationEventRow): number | null {
  const payload = parseEventPayload(event);
  return numberFrom(payload.capabilityId) ?? numberFrom(payload.capability_id);
}

function dependencyItemIdFromEvent(event: ContinuationEventRow): number | null {
  const payload = parseEventPayload(event);
  return event.item_id
    ?? numberFrom(payload.itemId)
    ?? numberFrom(payload.item_id)
    ?? numberFrom(payload.dependentItemId)
    ?? numberFrom(payload.dependent_item_id)
    ?? numberFrom(payload.dependentTicketId)
    ?? numberFrom(payload.dependent_ticket_id);
}

function stepTicketId(context: ContinuationContext, step: number): number | null {
  const value = context[`step:${step}`];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return numberFrom((value as { ticketId?: unknown }).ticketId);
}

function currentWaitingTicketId(
  row: ContinuationRow,
  context: ContinuationContext,
  action: ContinuationAction | undefined,
): number | null {
  if (!action) return null;
  try {
    if (action.type === "create_task") {
      return context.createdTickets?.[action.key] ?? stepTicketId(context, row.current_step);
    }
    if (action.type === "request_dispatch") return ticketFromAction(context, action);
  } catch {
    return null;
  }
  return null;
}

function actionsReferenceCapability(actions: ContinuationAction[], capabilityId: number): boolean {
  return actions.some((action) =>
    action.type === "wait_for_capability" && action.capabilityId === capabilityId);
}

function actionRequiresDelegation(action: ContinuationAction): boolean {
  return action.type === "create_task"
    || action.type === "link_tickets"
    || action.type === "request_dispatch";
}

function readDelegationPolicy(db: Db, id: number): DelegationPolicy | undefined {
  return db.prepare("SELECT * FROM delegation_policies WHERE id=?").get(id) as
    DelegationPolicy | undefined;
}

function delegationBlockReason(
  db: Db,
  row: ContinuationRow,
  actions: ContinuationAction[],
  now: Date,
): string | null {
  if (!actions.some(actionRequiresDelegation)) return null;
  if (row.delegation_policy_id === null) {
    return "continuation has mutating actions but no persisted delegation_policy_id";
  }
  const policy = readDelegationPolicy(db, row.delegation_policy_id);
  if (!policy) return `delegation policy #${row.delegation_policy_id} does not exist`;
  if (policy.revoked_at !== null) {
    return `delegation policy #${policy.id} was revoked at ${policy.revoked_at}: ${policy.revoke_reason ?? ""}`;
  }
  if (policy.mode !== "technical_delivery") {
    return `delegation policy #${policy.id} mode=${policy.mode} cannot run continuations`;
  }
  if (policy.acceptance_policy !== "delegated_to_lead") {
    return `delegation policy #${policy.id} acceptance_policy=${policy.acceptance_policy} is not delegated_to_lead`;
  }
  if (policy.delivery_policy !== "continue_workflow") {
    return `delegation policy #${policy.id} delivery_policy=${policy.delivery_policy} does not allow continuation`;
  }
  if (policy.effective_until !== null && policy.effective_until <= now.toISOString()) {
    return `delegation policy #${policy.id} expired at ${policy.effective_until}`;
  }
  if (row.item_id !== null && policy.item_id !== null && policy.item_id !== row.item_id) {
    return `delegation policy #${policy.id} belongs to item #${policy.item_id}, not item #${row.item_id}`;
  }
  return null;
}

function blockContinuationForUser(db: Db, row: ContinuationRow, reason: string): void {
  updateContinuationState(db, row.id, {
    state: "waiting_user",
    currentStep: row.current_step,
    lastError: reason,
    nextRetryAt: null,
  });
  const policy = row.delegation_policy_id === null ? null : readDelegationPolicy(db, row.delegation_policy_id);
  addNotification(db, {
    itemId: row.item_id,
    kind: "automation_blocked",
    urgency: "immediate",
    title: `Continuation #${row.id} automation blocked`,
    body: [
      reason,
      policy ? delegationAuthorityLabel(policy) : null,
    ].filter(Boolean).join("\n"),
    dedupKey: `continuation:${row.id}:authorization-blocked`,
  });
}

function eventCanTriggerRow(
  row: ContinuationRow,
  event: ContinuationEventRow,
  actions: ContinuationAction[],
  context: ContinuationContext,
): boolean {
  if (row.state === "waiting_dependency") {
    if (event.event_type !== "dependency_satisfied") return false;
    const currentAction = actions[row.current_step];
    const waitingTicketId = currentWaitingTicketId(row, context, currentAction);
    const eventItemId = dependencyItemIdFromEvent(event);
    return waitingTicketId !== null && eventItemId === waitingTicketId;
  }
  if (row.state === "waiting_capability") {
    if (event.event_type !== "capability_deployed") return false;
    const capabilityId = capabilityIdFromEvent(event);
    return capabilityId === null || actionsReferenceCapability(actions, capabilityId);
  }

  if (row.trigger_event !== event.event_type) return false;
  if (row.item_id !== null && event.item_id !== null && row.item_id !== event.item_id) return false;
  if (event.event_type === "capability_deployed") {
    const capabilityId = capabilityIdFromEvent(event);
    return capabilityId === null || actionsReferenceCapability(actions, capabilityId);
  }
  return true;
}

function continuationsForEvent(db: Db, event: ContinuationEventRow, now: Date): ContinuationRow[] {
  return db.prepare(
    `SELECT * FROM continuations
     WHERE state IN ('pending','running','waiting_dependency','waiting_capability')
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
       AND (
         (state IN ('pending','running') AND trigger_event=?)
         OR (state='waiting_dependency' AND ?='dependency_satisfied')
         OR (state='waiting_capability' AND ?='capability_deployed')
       )
     ORDER BY id`,
  ).all(now.toISOString(), event.event_type, event.event_type, event.event_type) as ContinuationRow[];
}

function inProgressContinuations(db: Db, now: Date): ContinuationRow[] {
  return db.prepare(
    `SELECT * FROM continuations
     WHERE state IN ('running','waiting_dependency','waiting_capability')
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY id`,
  ).all(now.toISOString()) as ContinuationRow[];
}

function waitForCapability(
  db: Db,
  row: ContinuationRow,
  action: Extract<ContinuationAction, { type: "wait_for_capability" }>,
): "advanced" | "waiting" {
  const capability = getCapability(db, action.capabilityId);
  if (capability && capabilityReadyForLeadUse(capability)) return "advanced";
  addNotification(db, {
    itemId: row.item_id,
    kind: "automation_blocked",
    urgency: "immediate",
    title: `Continuation #${row.id} waiting for capability #${action.capabilityId}`,
    body: capability
      ? `implementation=${capability.implementation_status}, deployed=${capability.deployment_status}, lead_tool=${capability.lead_tool_status}`
      : "Capability does not exist.",
    dedupKey: `continuation:${row.id}:capability:${action.capabilityId}:waiting`,
  });
  updateContinuationState(db, row.id, {
    state: "waiting_capability",
    currentStep: row.current_step,
    lastError: `capability #${action.capabilityId} is not deployed and loaded`,
  });
  return "waiting";
}

function createTask(
  db: Db,
  row: ContinuationRow,
  context: ContinuationContext,
  action: Extract<ContinuationAction, { type: "create_task" }>,
): { context: ContinuationContext; ticketId: number } {
  const existingId = context.createdTickets?.[action.key];
  if (existingId && getItem(db, existingId)) return { context, ticketId: existingId };
  const ticketId = createItem(db, {
    title: action.title,
    brief: action.brief,
    createdBy: "system",
    workdir: action.workdir,
    priority: action.priority,
    project: action.project,
    runtime: action.runtime,
    model: action.model,
    verificationPolicy: action.verificationPolicy,
  });
  for (const relation of action.relations ?? []) {
    linkTickets(db, {
      sourceTicketId: ticketId,
      targetTicketId: relation.targetTicketId,
      relationType: relation.relationType,
      reason: relation.reason,
      actor: "system",
    });
  }
  return {
    context: {
      ...context,
      createdTickets: { ...(context.createdTickets ?? {}), [action.key]: ticketId },
      [`step:${row.current_step}`]: { ticketId },
    },
    ticketId,
  };
}

function executeAction(
  db: Db,
  row: ContinuationRow,
  context: ContinuationContext,
  action: ContinuationAction,
  requestDispatch: (input: DispatchRequestInput) => void,
): { state: "advanced" | "waiting"; context: ContinuationContext } {
  switch (action.type) {
    case "wait_for_capability": {
      const state = waitForCapability(db, row, action);
      return { state, context };
    }
    case "create_task": {
      const created = createTask(db, row, context, action);
      if (action.requestDispatch) {
        const blockers = listBlockingDependencies(db, created.ticketId);
        if (blockers.length) {
          updateContinuationState(db, row.id, {
            state: "waiting_dependency",
            context: created.context,
            currentStep: row.current_step,
            lastError: `ticket #${created.ticketId} waits for ${blockers.map((b) => `#${b.id}`).join(", ")}`,
          });
          return { state: "waiting", context: created.context };
        }
        requestDispatch({
          itemId: created.ticketId,
          role: "executor",
          purpose: "execution",
          trigger: "continuation",
          idempotencyKey: `continuation:${row.id}:step:${row.current_step}:dispatch:${created.ticketId}`,
        });
      }
      return { state: "advanced", context: created.context };
    }
    case "link_tickets": {
      linkTickets(db, {
        sourceTicketId: sourceTicketFromAction(context, action),
        targetTicketId: action.targetTicketId,
        relationType: action.relationType,
        reason: action.reason,
        actor: "system",
      });
      return { state: "advanced", context };
    }
    case "request_dispatch": {
      const ticketId = ticketFromAction(context, action);
      const blockers = listBlockingDependencies(db, ticketId);
      if (blockers.length) {
        updateContinuationState(db, row.id, {
          state: "waiting_dependency",
          context,
          currentStep: row.current_step,
          lastError: `ticket #${ticketId} waits for ${blockers.map((b) => `#${b.id}`).join(", ")}`,
        });
        return { state: "waiting", context };
      }
      requestDispatch({
        itemId: ticketId,
        role: "executor",
        purpose: "execution",
        trigger: "continuation",
        idempotencyKey: `continuation:${row.id}:step:${row.current_step}:dispatch:${ticketId}`,
      });
      return { state: "advanced", context };
    }
  }
}

function failContinuation(db: Db, row: ContinuationRow, error: unknown, now: Date): "retry" | "failed" {
  const message = error instanceof Error ? error.message : String(error);
  if (row.retry_count < row.max_retries) {
    updateContinuationState(db, row.id, {
      state: "pending",
      lastError: message,
      nextRetryAt: new Date(now.getTime() + 1_000).toISOString(),
      incrementRetry: true,
    });
    return "retry";
  }
  updateContinuationState(db, row.id, {
    state: "failed",
    lastError: message,
  });
  // 先交给 Lead（2026-10-15 用户决定：异常先交给 Lead，需要你时才强提醒）：它看失败原因，能重做就重做；
  // 处理不了时 daemon 升级给用户（inbox.ts 的 escalateLeadRow）。
  addInbox(db, {
    ...(row.item_id !== null ? { itemId: row.item_id } : { dedupScope: `continuation:${row.id}` }),
    severity: "attention",
    source: "structural",
    summary: `Continuation #${row.id} failed: ${message.slice(0, 400)}`,
    payload: { kind: "continuation_failed", continuationId: row.id, message, wakeLead: true, needsUser: false },
    lossless: true,
  });
  return "failed";
}

export function processContinuations(
  db: Db,
  options: { now?: () => Date; requestDispatch: (input: DispatchRequestInput) => void },
): ContinuationRunnerResult {
  const now = options.now?.() ?? new Date();
  const result: ContinuationRunnerResult = {
    processed: 0,
    waitingDependency: 0,
    waitingCapability: 0,
    failed: 0,
  };
  const touched = new Set<number>();

  const runRow = (row: ContinuationRow): ContinuationStepResult => {
    try {
      let current = row.current_step;
      let context = parseContinuationContext(row.context);
      const actions = parseContinuationActions(row.action_sequence);
      const blocked = delegationBlockReason(db, row, actions, now);
      if (blocked) {
        blockContinuationForUser(db, row, blocked);
        return "blocked";
      }
      if (current >= actions.length) {
        updateContinuationState(db, row.id, {
          state: "succeeded",
          currentStep: current,
          context,
          lastError: null,
          nextRetryAt: null,
        });
        result.processed++;
        return "advanced";
      }
      updateContinuationState(db, row.id, { state: "running", lastError: null, nextRetryAt: null });
      while (current < actions.length) {
        const stepRow = { ...row, current_step: current };
        const executed = db.transaction(() =>
          executeAction(db, stepRow, context, actions[current]!, options.requestDispatch)
        ).immediate();
        context = executed.context;
        if (executed.state === "waiting") {
          const updated = (db.prepare("SELECT state FROM continuations WHERE id=?").get(row.id) as
            { state: string } | undefined)?.state;
          if (updated === "waiting_dependency") result.waitingDependency++;
          else if (updated === "waiting_capability") result.waitingCapability++;
          result.processed++;
          return "waiting";
        }
        current++;
        updateContinuationState(db, row.id, {
          state: current >= actions.length ? "succeeded" : "running",
          currentStep: current,
          context,
          lastError: null,
          nextRetryAt: null,
        });
      }
      result.processed++;
      return "advanced";
    } catch (error) {
      const state = failContinuation(db, row, error, now);
      result.failed++;
      return state;
    }
  };

  for (const event of pendingContinuationEvents(db)) {
    let matched = 0;
    let retry = false;
    for (const row of continuationsForEvent(db, event, now)) {
      if (touched.has(row.id)) continue;
      const actions = parseContinuationActions(row.action_sequence);
      const context = parseContinuationContext(row.context);
      if (!eventCanTriggerRow(row, event, actions, context)) continue;
      matched++;
      touched.add(row.id);
      const outcome = runRow(row);
      if (outcome === "retry") retry = true;
    }
    if (matched > 0 && !retry) {
      updateContinuationEventState(db, event.id, { state: "processed", processedAt: now });
    }
  }

  for (const row of inProgressContinuations(db, now)) {
    if (touched.has(row.id)) continue;
    touched.add(row.id);
    runRow(row);
  }

  return result;
}
