import type { Db } from "./db.js";
import { addActivity } from "./activities.js";
import { capabilityReadyForLeadUse, getCapability } from "./learning.js";
import type {
  AcceptancePolicy,
  DeliveryPolicy,
  ReworkPolicy,
  VerificationPolicy,
} from "@pi-lead-child/core";

export type DelegationMode = "technical_delivery" | "disabled";
export type DelegationVia = "cli" | "control-plane" | "test";
export type DelegationCreatedVia = DelegationVia | "migration";

export interface DelegationPolicy {
  id: number;
  item_id: number | null;
  mode: DelegationMode;
  scope: string;
  verification_policy: VerificationPolicy;
  acceptance_policy: AcceptancePolicy;
  rework_policy: ReworkPolicy;
  delivery_policy: DeliveryPolicy;
  max_rework_cycles: number;
  budget_limit_tokens: number | null;
  budget_limit_usd: number | null;
  effective_until: string | null;
  created_by: "user" | "system";
  created_via: DelegationCreatedVia;
  policy_version: number;
  escalation_conditions: string;
  revoked_at: string | null;
  revoked_by: "user" | "system" | null;
  revoked_via: DelegationVia | null;
  revoke_reason: string | null;
  created_at: string;
  // 授权时预先勾选的「核查做不成时，由 Lead 凭它读过的证据验收」（v58，spec D11）。1：勾了；0：没勾，工单等你验收。
  accept_without_review: number;
}

export interface GrantDelegationPolicyInput {
  itemId?: number | null;
  mode?: DelegationMode;
  scope?: string;
  maxReworkCycles?: number;
  budgetLimitTokens?: number | null;
  budgetLimitUsd?: number | null;
  effectiveUntil?: string | null;
  createdVia: DelegationCreatedVia;
  escalationConditions?: string[];
  verificationPolicy?: VerificationPolicy;
  acceptancePolicy?: AcceptancePolicy;
  reworkPolicy?: ReworkPolicy;
  deliveryPolicy?: DeliveryPolicy;
  // 核查做不成时（所有核查员都不能用），Lead 可以凭它读过的证据验收，账本标明没有独立核查（spec D11）。默认不勾。
  acceptWithoutReview?: boolean;
}

export type DelegationPreflightState = "passed" | "warning" | "failed";
export interface DelegationPreflightCheck {
  id: string;
  label: string;
  state: DelegationPreflightState;
  evidence: string;
}

export interface DelegationPreflight {
  itemId: number;
  status: "ready" | "limited" | "blocked";
  canAccept: boolean;
  checks: DelegationPreflightCheck[];
  blockers: string[];
  warnings: string[];
}

export interface DelegationPreflightInput extends GrantDelegationPolicyInput {
  itemId: number;
  requireContinuation?: boolean;
  requiredCapabilityId?: number | null;
  now?: Date;
  // 现在能不能派出独立核查（engine 的 reviewerAvailability）。调用方算好传进来：store 不读 runtime 的配置。
  // 不给时不检查这一项。
  reviewer?: { available: true; runtime: string } | { available: false; runtime: string; reason: string };
}

export function activeDelegationPolicy(
  db: Db,
  itemId: number,
  now: Date = new Date(),
): DelegationPolicy | null {
  const rows = db.prepare(
    `SELECT * FROM delegation_policies
     WHERE revoked_at IS NULL
       AND mode = 'technical_delivery'
       AND acceptance_policy = 'delegated_to_lead'
       AND (item_id = ? OR item_id IS NULL)
     ORDER BY item_id IS NULL, id DESC`,
  ).all(itemId) as DelegationPolicy[];
  const nowIso = now.toISOString();
  return rows.find((row) => row.effective_until === null || row.effective_until > nowIso) ?? null;
}

export function grantDelegationPolicy(
  db: Db,
  input: GrantDelegationPolicyInput,
): DelegationPolicy {
  const scope = input.scope?.trim() || "technical_acceptance_rework_delivery";
  if (input.itemId !== undefined && input.itemId !== null) {
    const item = db.prepare("SELECT kind FROM items WHERE id=?").get(input.itemId) as
      { kind: string } | undefined;
    if (!item) throw new Error(`item #${input.itemId} not found`);
    if (item.kind !== "task") throw new Error("delegation can only target a task item");
  }
  if (input.maxReworkCycles !== undefined
      && (!Number.isSafeInteger(input.maxReworkCycles) || input.maxReworkCycles < 0)) {
    throw new Error("max_rework_cycles must be a non-negative integer");
  }
  if (input.budgetLimitTokens !== undefined && input.budgetLimitTokens !== null
      && (!Number.isSafeInteger(input.budgetLimitTokens) || input.budgetLimitTokens < 0)) {
    throw new Error("budget_limit_tokens must be a non-negative integer");
  }
  if (input.budgetLimitUsd !== undefined && input.budgetLimitUsd !== null
      && (!Number.isFinite(input.budgetLimitUsd) || input.budgetLimitUsd < 0)) {
    throw new Error("budget_limit_usd must be a non-negative number");
  }
  if (input.effectiveUntil !== undefined && input.effectiveUntil !== null) {
    const expires = new Date(input.effectiveUntil);
    if (Number.isNaN(expires.getTime())) throw new Error("effective_until must be a valid ISO timestamp");
  }
  return db.transaction(() => {
    db.prepare(
      `UPDATE delegation_policies
       SET revoked_at=datetime('now'), revoked_by='user', revoked_via=?, revoke_reason=?
       WHERE revoked_at IS NULL AND item_id IS ?`,
    ).run(input.createdVia === "migration" ? "test" : input.createdVia, "superseded by a newer delegation policy", input.itemId ?? null);
    const result = db.prepare(
      `INSERT INTO delegation_policies (
         item_id, mode, scope, verification_policy, acceptance_policy,
         rework_policy, delivery_policy, max_rework_cycles,
         budget_limit_tokens, budget_limit_usd, effective_until,
         created_by, created_via, escalation_conditions, accept_without_review
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?)`,
    ).run(
      input.itemId ?? null,
      input.mode ?? "technical_delivery",
      scope,
      input.verificationPolicy ?? "independent_reviewer",
      input.acceptancePolicy ?? "delegated_to_lead",
      input.reworkPolicy ?? "automatic",
      input.deliveryPolicy ?? "continue_workflow",
      input.maxReworkCycles ?? 1,
      input.budgetLimitTokens ?? null,
      input.budgetLimitUsd ?? null,
      input.effectiveUntil ?? null,
      input.createdVia,
      JSON.stringify(input.escalationConditions ?? [
        "requirement_change",
        "evidence_conflict",
        "irreversible_action",
        "external_approval",
        "budget_exhausted",
        "rework_exhausted",
        "capability_not_deployed",
      ]),
      input.acceptWithoutReview ? 1 : 0,
    );
    if (input.itemId !== undefined && input.itemId !== null) {
      db.prepare(
        `UPDATE items
         SET verification_policy=?, acceptance_policy=?, rework_policy=?, delivery_policy=?,
             updated_at=datetime('now')
         WHERE id=?`,
      ).run(
        input.verificationPolicy ?? "independent_reviewer",
        input.acceptancePolicy ?? "delegated_to_lead",
        input.reworkPolicy ?? "automatic",
        input.deliveryPolicy ?? "continue_workflow",
        input.itemId,
      );
    }
    return db.prepare("SELECT * FROM delegation_policies WHERE id=?")
      .get(Number(result.lastInsertRowid)) as DelegationPolicy;
  })();
}

function schemaObjectExists(db: Db, type: "table" | "index", name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type=? AND name=?")
    .get(type, name));
}

function continuationCount(db: Db, itemId: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM continuations
     WHERE item_id=? AND state NOT IN ('succeeded','failed')`,
  ).get(itemId) as { n: number }).n;
}

export function delegationPreflight(
  db: Db,
  input: DelegationPreflightInput,
): DelegationPreflight {
  const checks: DelegationPreflightCheck[] = [];
  const add = (check: DelegationPreflightCheck) => checks.push(check);
  const now = input.now ?? new Date();
  const item = db.prepare(
    "SELECT id, kind, stage, verification_policy FROM items WHERE id=?",
  ).get(input.itemId) as { id: number; kind: string; stage: string; verification_policy: VerificationPolicy | null } | undefined;
  add(item && item.kind === "task"
    ? {
        id: "target_task",
        label: "Delegation target",
        state: "passed",
        evidence: `item #${input.itemId} is a task in ${item.stage}`,
      }
    : {
        id: "target_task",
        label: "Delegation target",
        state: "failed",
        evidence: item ? `item #${input.itemId} is ${item.kind}, not a task` : `item #${input.itemId} not found`,
      });

  // 不要求独立核查的工单不能授权托管（spec 5.8，2026-10-21 定）：托管验收靠核查员的结论，这类工单没有核查员，托管不起作用
  // （例如 #101 Lead 静态核对、#18 总工单）。看工单自己的 verification_policy。以前看的是这次授权的默认值（总是独立核查），
  // 授权时再把工单改成独立核查：#102 的 review_policy 是 manual，授权以后照样派了核查（spec 5.9）。
  const verificationPolicy = item?.verification_policy ?? input.verificationPolicy ?? "independent_reviewer";
  add(verificationPolicy === "independent_reviewer"
    ? {
        id: "verification_authority",
        label: "Verification authority",
        state: "passed",
        evidence: "independent reviewer verdict is required",
      }
    : {
        id: "verification_authority",
        label: "Verification authority",
        state: "failed",
        evidence: `这张工单不要求独立核查（verification_policy=${verificationPolicy}）。托管验收靠核查员的结论，`
          + "这张工单没有核查员，托管不起作用。你可以亲自验收这张工单。",
      });

  // 委托以后 Lead 要靠独立核查的结论验收（ticket_action 的 complete）。核查派不出去时，Lead 永远拿不到结论，工单关不掉，
  // 用户也不知道（2026-10-19，工单 #88、#89、#92、#93、#98）。所以委托前就说清楚，委托不生效。
  // 例外是你预先勾选了「核查做不成时由 Lead 凭证据验收」（D11）：这时委托照样生效，只提醒一句。
  if (input.reviewer && verificationPolicy === "independent_reviewer") {
    add(input.reviewer.available
      ? {
          id: "reviewer_runtime",
          label: "Independent reviewer",
          state: "passed",
          evidence: `independent review runs on ${input.reviewer.runtime}`,
        }
      : input.acceptWithoutReview
        ? {
            id: "reviewer_runtime",
            label: "Independent reviewer",
            state: "warning",
            evidence: `现在派不出独立核查。${input.reviewer.reason}你勾选了「核查做不成时由 Lead 凭证据验收」：`
              + "核查恢复以前，Lead 会凭它读过的证据验收，账本标明没有独立核查。",
          }
        : {
            id: "reviewer_runtime",
            label: "Independent reviewer",
            state: "failed",
            evidence: `现在派不出独立核查，委托以后 Lead 拿不到核查结论，不能替你验收。${input.reviewer.reason}`
              + "你可以亲自验收这张工单，等核查恢复以后再委托，或者勾选「核查做不成时由 Lead 凭证据验收」。",
          });
  }
  add({
    id: "review_fallback",
    label: "When review cannot run",
    state: "passed",
    evidence: input.acceptWithoutReview
      ? "所有核查员都不能用时，Lead 凭它读过的证据验收，账本标明没有独立核查"
      : "所有核查员都不能用时，工单等你验收，只通知你一次",
  });

  const acceptancePolicy = input.acceptancePolicy ?? "delegated_to_lead";
  add(acceptancePolicy === "delegated_to_lead"
    ? {
        id: "acceptance_authority",
        label: "Acceptance authority",
        state: "passed",
        evidence: "acceptance_policy delegates technical acceptance to Lead",
      }
    : {
        id: "acceptance_authority",
        label: "Acceptance authority",
        state: "failed",
        evidence: `acceptance_policy=${acceptancePolicy} keeps acceptance user-only`,
      });

  const reworkPolicy = input.reworkPolicy ?? "automatic";
  const maxReworkCycles = input.maxReworkCycles ?? 1;
  add(reworkPolicy === "automatic" && maxReworkCycles > 0
    ? {
        id: "rework_authority",
        label: "Rework authority",
        state: "passed",
        evidence: `automatic rework is allowed for ${maxReworkCycles} cycle(s)`,
      }
    : {
        id: "rework_authority",
        label: "Rework authority",
        state: "failed",
        evidence: reworkPolicy === "automatic"
          ? "max_rework_cycles must be greater than 0 for unattended rework"
          : `rework_policy=${reworkPolicy} requires user input on reviewer FAIL`,
      });

  const hasBudget = input.budgetLimitTokens !== undefined
    || input.budgetLimitUsd !== undefined;
  const invalidBudget = (input.budgetLimitTokens !== undefined && input.budgetLimitTokens !== null
      && (!Number.isSafeInteger(input.budgetLimitTokens) || input.budgetLimitTokens <= 0))
    || (input.budgetLimitUsd !== undefined && input.budgetLimitUsd !== null
      && (!Number.isFinite(input.budgetLimitUsd) || input.budgetLimitUsd <= 0));
  add(invalidBudget
    ? {
        id: "budget_boundary",
        label: "Budget boundary",
        state: "failed",
        evidence: "budget limits, when provided, must be positive",
      }
    : {
        id: "budget_boundary",
        label: "Budget boundary",
        state: hasBudget ? "passed" : "warning",
        evidence: hasBudget
          ? `tokens=${input.budgetLimitTokens ?? "none"}, usd=${input.budgetLimitUsd ?? "none"}`
          : "no explicit budget cap was provided",
      });

  if (input.effectiveUntil !== undefined && input.effectiveUntil !== null) {
    const expires = new Date(input.effectiveUntil);
    add(!Number.isNaN(expires.getTime()) && expires > now
      ? {
          id: "effective_window",
          label: "Effective window",
          state: "passed",
          evidence: `delegation expires at ${expires.toISOString()}`,
        }
      : {
          id: "effective_window",
          label: "Effective window",
          state: "failed",
          evidence: "effective_until must be a future ISO timestamp",
        });
  } else {
    add({
      id: "effective_window",
      label: "Effective window",
      state: "warning",
      evidence: "no expiry was provided",
    });
  }

  const escalationConditions = input.escalationConditions ?? [
    "requirement_change",
    "evidence_conflict",
    "irreversible_action",
    "external_approval",
    "budget_exhausted",
    "rework_exhausted",
    "capability_not_deployed",
  ];
  const missingEscalations = [
    "requirement_change",
    "evidence_conflict",
    "irreversible_action",
    "external_approval",
    "budget_exhausted",
    "rework_exhausted",
  ].filter((condition) => !escalationConditions.includes(condition));
  add(missingEscalations.length === 0
    ? {
        id: "approval_boundary",
        label: "Approval boundary",
        state: "passed",
        evidence: "irreversible, external approval, conflict, budget, and rework exhaustion escalate",
      }
    : {
        id: "approval_boundary",
        label: "Approval boundary",
        state: "failed",
        evidence: `missing escalation conditions: ${missingEscalations.join(", ")}`,
      });

  const outboxReady = schemaObjectExists(db, "table", "notifications")
    && schemaObjectExists(db, "index", "notifications_dedup");
  add(outboxReady
    ? {
        id: "notification_outbox",
        label: "Notification outbox",
        state: "passed",
        evidence: "notifications table and dedup index are present",
      }
    : {
        id: "notification_outbox",
        label: "Notification outbox",
        state: "failed",
        evidence: "notification outbox schema is missing",
      });

  const continuations = item ? continuationCount(db, input.itemId) : 0;
  add(continuations > 0
    ? {
        id: "continuation_chain",
        label: "Continuation chain",
        state: "passed",
        evidence: `${continuations} active continuation row(s) exist for item #${input.itemId}`,
      }
    : {
        id: "continuation_chain",
        label: "Continuation chain",
        state: input.requireContinuation ? "failed" : "warning",
        evidence: input.requireContinuation
          ? "a real continuation is required but none exists"
          : "no continuation exists yet; follow-up work must be added as a structured continuation before it can run",
      });

  if (input.requiredCapabilityId !== undefined && input.requiredCapabilityId !== null) {
    const capability = getCapability(db, input.requiredCapabilityId);
    add(capability && capabilityReadyForLeadUse(capability)
      ? {
          id: "capability_ready",
          label: "Capability readiness",
          state: "passed",
          evidence: `capability #${input.requiredCapabilityId} is implemented, deployed, and loaded`,
        }
      : {
          id: "capability_ready",
          label: "Capability readiness",
          state: "failed",
          evidence: capability
            ? `capability #${input.requiredCapabilityId} is implementation=${capability.implementation_status}, `
              + `deployed=${capability.deployment_status}, lead_tool=${capability.lead_tool_status}`
            : `capability #${input.requiredCapabilityId} not found`,
        });
  } else {
    add({
      id: "capability_ready",
      label: "Capability readiness",
      state: "warning",
      evidence: "no required capability was declared for this delegation",
    });
  }

  const blockers = checks.filter((check) => check.state === "failed").map((check) => check.evidence);
  const warnings = checks.filter((check) => check.state === "warning").map((check) => check.evidence);
  return {
    itemId: input.itemId,
    status: blockers.length ? "blocked" : warnings.length ? "limited" : "ready",
    canAccept: blockers.length === 0,
    checks,
    blockers,
    warnings,
  };
}

export function recordDelegationPreflight(
  db: Db,
  input: {
    itemId: number;
    preflight: DelegationPreflight;
    policyId?: number;
    actor: "user" | "lead";
    channel: DelegationVia | "lead_tool";
    accepted: boolean;
  },
): number {
  return addActivity(db, {
    itemId: input.itemId,
    actor: input.actor,
    kind: "decision",
    payload: {
      decision: input.accepted ? "delegation_preflight_accepted" : "delegation_preflight_blocked",
      policyId: input.policyId ?? null,
      channel: input.channel,
      preflight: input.preflight,
    },
  });
}

export function revokeDelegationPolicy(
  db: Db,
  input: { itemId?: number | null; policyId?: number; via: DelegationVia; reason: string },
): number {
  const reason = input.reason.trim();
  if (!reason) throw new Error("revoke reason is required");
  if (input.policyId !== undefined) {
    return db.prepare(
      `UPDATE delegation_policies
       SET revoked_at=datetime('now'), revoked_by='user', revoked_via=?, revoke_reason=?
       WHERE id=? AND revoked_at IS NULL`,
    ).run(input.via, reason, input.policyId).changes;
  }
  return db.prepare(
    `UPDATE delegation_policies
     SET revoked_at=datetime('now'), revoked_by='user', revoked_via=?, revoke_reason=?
     WHERE item_id IS ? AND revoked_at IS NULL`,
  ).run(input.via, reason, input.itemId ?? null).changes;
}

export function listDelegationPolicies(
  db: Db,
  itemId?: number | null,
): DelegationPolicy[] {
  return (itemId === undefined
    ? db.prepare("SELECT * FROM delegation_policies ORDER BY id DESC").all()
    : db.prepare("SELECT * FROM delegation_policies WHERE item_id IS ? ORDER BY id DESC")
      .all(itemId)) as DelegationPolicy[];
}

export function delegationAuthorityLabel(policy: DelegationPolicy): string {
  return `delegation policy #${policy.id} v${policy.policy_version} `
    + `(created ${policy.created_at} via ${policy.created_via}, scope=${policy.scope})`;
}
