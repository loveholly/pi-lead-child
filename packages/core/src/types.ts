export type ItemKind = "task" | "reminder";
export type ItemWorkflowKind = "generic" | "coding";
export type TaskStage =
  | "draft" | "ready" | "active" | "blocked" | "review" | "done" | "cancelled";
export type ReminderStage = "scheduled" | "fired" | "acked" | "cancelled";
export type ItemStage = TaskStage | ReminderStage;
export type Actor = "user" | "lead" | "child" | "system";
export type ActivityKind =
  | "comment" | "transition" | "milestone" | "notification" | "decision"
  | "attempt_start" | "attempt_end" | "crash";

export type ItemPriority = "urgent" | "high" | "normal" | "low";
export type RuntimeId = "pi" | "codex" | "claude";
// outcome_repair 是成果修复回合（spec D4）：它 resume 一个执行 Run 的外部 session，只补交成果。
// lookup 是代查（slack-takeover spec D5）：进程内的受限 pi 会话，只读查询，结果交给通道 hub。它不是交付，
// 不进瞬时重试，崩溃和重启不把工单打成 blocked，结束不叫醒 Lead。
// 这两个值只在库里和 src/ 里使用。线上契约没有它们，出站投影把它们报成 execution（wire-vocabulary.ts）。
export type RunPurpose =
  | "execution" | "review" | "integration" | "learning" | "conversation" | "outcome_repair" | "lookup";

// 类型化失败（spec D1）。scope 回答"谁能修好"，retry 回答"重试有没有用"，needs 回答"需要谁做什么"。
// 只有 task 和 unknown 扣工单的重试额度，也只有这两种邀请 lead 参与决定。
export const FAILURE_SCOPES = ["attempt", "runtime", "account", "host", "task", "unknown"] as const;
export const FAILURE_RETRIES = ["resume", "backoff", "other_runtime", "never"] as const;
export const FAILURE_NEEDS = ["none", "login", "refill", "config", "code_fix"] as const;
export type FailureScope = typeof FAILURE_SCOPES[number];
export type FailureRetry = typeof FAILURE_RETRIES[number];
export type FailureNeeds = typeof FAILURE_NEEDS[number];
export interface TypedFailure {
  scope: FailureScope;
  retry: FailureRetry;
  needs: FailureNeeds;
  code: string;
  // 有长度上限的原始证据：原生错误文本加 stderr 末尾。
  evidence: string;
}
export type PlanState = "none" | "planning" | "waiting" | "integrating" | "failed";
export type VerificationPolicy = "independent_reviewer" | "lead_static" | "user";
export type AcceptancePolicy = "user_only" | "delegated_to_lead";
export type ReworkPolicy = "ask_user" | "automatic";
export type DeliveryPolicy = "notify_only" | "continue_workflow";

export interface Item {
  id: number; kind: ItemKind; workflow_kind: ItemWorkflowKind; title: string; body: string; stage: ItemStage; brief: string;
  // 显示用的短标题（v39）；没写时为 null，界面用原标题。
  display_title: string | null;
  // 提醒的设置（v48，JSON，protocol 的 ReminderPolicy）：级别、提前提醒、重复推送、关联的工单。只有提醒有；NULL 是缺省设置。
  reminder_policy?: string | null;
  priority: ItemPriority; project: string | null;
  // root 可空：自根行走 insert-then-update 协议（items.ts createItem），
  // 两步之间它就是 NULL，类型不该断言一条 DDL 与写入协议都不保证的不变量。
  project_id: number | null; parent_item_id: number | null; root_item_id: number | null;
  created_by_run_id: number | null; plan_state: PlanState | null;
  requested_runtime: RuntimeId | null; requested_model: string | null;
  purpose: RunPurpose | null;
  // 谁核查。items 表里还有一列 v56 停用的旧列（代码不读写，见 store 的 schema.ts），这里不列它。
  verification_policy: VerificationPolicy | null;
  acceptance_policy: AcceptancePolicy | null;
  rework_policy: ReworkPolicy | null;
  delivery_policy: DeliveryPolicy | null;
  max_depth: number | null; max_children: number | null; max_concurrency: number | null;
  token_budget: number | null; cost_budget_usd: number | null; retry_limit: number | null;
  active_plan_revision: number | null;
  first_run_at: string | null; closed_at: string | null;
  stage_changed_at: string;
  workdir: string | null; created_by: Actor; created_at: string; updated_at: string;
  last_activity_at: string | null; total_tokens: number; total_cost_usd: number;
  due_at: string | null; defer_until: string | null;
  remind_at: string | null; due_overdue_notified: number;
}
export type WorkspaceMode = "shared" | "isolated";
export type WorkspaceKind = "primary" | "isolated_child" | "reviewer" | "experiment";
export type WorkspaceState =
  | "requested" | "provisioning" | "active" | "idle" | "review_hold"
  | "pending_integration" | "released" | "cleaning" | "cleaned" | "archived"
  | "failed" | "blocked";
export type WorkspaceMergeStatus = "n/a" | "pending" | "merged" | "conflict" | "abandoned";

export interface Workspace {
  id: number;
  owner_item_id: number;
  mode: WorkspaceMode;
  kind: WorkspaceKind;
  project_id: number | null;
  repo_root: string | null;
  path: string;
  branch: string | null;
  base_ref: string | null;
  git_worktree: number;
  source_item_id: number | null;
  source_run_id: number | null;
  reused_from_workspace_id: number | null;
  state: WorkspaceState;
  merge_status: WorkspaceMergeStatus;
  created_at: string;
  last_used_at: string | null;
  retained_until: string | null;
  released_at: string | null;
  cleaned_at: string | null;
}

export interface Run {
  id: number; item_id: number; role: "executor" | "reviewer";
  session_id: string | null; session_path: string | null; pid: number | null;
  // Run 的生命周期与 Item 的 stage 相互独立（spec §3.2）：paused 是 Run 的事，
  // item 停在 active 不动——"手动暂停"因此不需要新增任何 item 状态。
  state: "starting" | "running" | "paused" | "finished" | "failed" | "stopped";
  model: string | null; started_at: string; ended_at: string | null;
  paused_at: string | null; paused_ms: number;
  last_entry_cursor: string | null;
  runtime: RuntimeId; purpose: RunPurpose; runtime_version: string | null;
  workspace_id: number | null;
  external_session_id: string | null; resumed_from_run_id: number | null; event_cursor: string | null;
  exit_code: number | null; error_code: string | null; error_message: string | null;
  // v26 之前落库的失败 Run 没有类型，这几列为 NULL，读取时走内核的兜底分类器。
  failure_scope: FailureScope | null; failure_retry: FailureRetry | null;
  failure_needs: FailureNeeds | null; failure_code: string | null; failure_evidence: string | null;
  // 这个 Run 用的 RuntimeProfile 内容 hash（工单 05）。v31 之前创建的 Run 为 NULL。
  runtime_profile_hash: string | null;
  // 启动垫片的身份和输出游标，都是 JSON（工单 14）。不是垫片启动的 Run 为 NULL。
  launcher: string | null; output_cursor: string | null;
  // 推理强度（v38）：Claude Code 的 --effort、Codex 的 model_reasoning_effort、pi 的 --thinking。
  // 没有选时为 NULL，由 CLI 自己决定。v38 之前的 Run 也是 NULL。
  effort: string | null;
  metadata: string; cost_known: number; event_log_dirty: number;
}
export interface Activity {
  id: number; item_id: number; run_id: number | null; actor: Actor;
  kind: ActivityKind; payload: string; session_cursor: string | null; created_at: string;
}

export type CheckpointKind =
  | "progress" | "milestone" | "decision" | "delegation" | "blocked" | "completed";
export type CheckpointSource = "agent_reported" | "system_derived";
export interface CheckpointFact { label: string; value: string }
export interface CheckpointActionRef {
  type: "approval" | "decision_request";
  id: number;
}
export interface CheckpointProgress {
  current: number;
  total: number;
  label: string | null;
}
export type CheckpointProofState = "pending" | "passed" | "failed" | "retired";
export interface CheckpointProofItem {
  id: string;
  label: string;
  state: CheckpointProofState;
  evidence: string | null;
}
export interface Checkpoint {
  id: number;
  itemId: number;
  runId: number | null;
  author: { kind: "executor" | "reviewer" | "system"; runtime: RuntimeId | null };
  source: CheckpointSource;
  kind: CheckpointKind;
  stage: string | null;
  title: string;
  summary: string;
  keyFacts: CheckpointFact[];
  artifactRefs: string[];
  relatedItemIds: number[];
  nextStep: string | null;
  actionRef: CheckpointActionRef | null;
  progress: CheckpointProgress | null;
  proofItems: CheckpointProofItem[];
  createdAt: string;
}

export type ArtifactAvailability = "available" | "metadata_only" | "unavailable";
export interface Artifact {
  id: number;
  itemId: number;
  runId: number | null;
  checkpointId: number;
  ref: string;
  name: string;
  kind: string;
  mediaType: string;
  description: string | null;
  availability: ArtifactAvailability;
  byteLength: number | null;
  sha256: string | null;
  createdAt: string;
}

export type DecisionRequestKind = "decision" | "question" | "blocker";
export type DecisionRequestAudience = "lead" | "user" | "lead_or_user";
export type DecisionRequestState = "pending" | "resolved" | "dismissed" | "expired";
export type DecisionResolutionKind = "option" | "text" | "dismissed" | "expired";
export interface DecisionOption { id: string; label: string; description: string | null }
export interface DecisionRequest {
  id: number;
  itemId: number;
  runId: number | null;
  // 谁发起的：agent（一个 Run 里的 request_decision）或 lead（Lead 在会话里用 render_ui 发起，没有 Run）。
  origin: "agent" | "lead";
  kind: DecisionRequestKind;
  audience: DecisionRequestAudience;
  blocking: boolean;
  allowCustom: boolean;
  prompt: string;
  options: DecisionOption[];
  state: DecisionRequestState;
  resolutionKind: DecisionResolutionKind | null;
  selectedOptionId: string | null;
  resolutionText: string | null;
  dismissalReason: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface Approval {
  id: number; item_id: number | null; run_id: number | null; requested_by: string;
  tool: string; action: string; payload: string;
  status: "pending" | "approved" | "rejected" | "expired";
  session_exempt: number; resolved_by: string | null; resolved_at: string | null;
  expires_at: string; created_at: string;
}

export type ItemOperationState = "started" | "running" | "completed" | "failed";
export interface ItemOperationProjection {
  id: string;
  name: string;
  state: ItemOperationState;
  label: string;
  detail: string | null;
}
interface ConversationCardBase {
  id: number;
  key: string;
  turnId: string | null;
  itemId: number;
  createdAt: string;
  updatedAt: string;
}
export type ConversationCard =
  | ConversationCardBase & {
      kind: "ticket_execution";
      turnId: string;
      operations: ItemOperationProjection[];
      operationsTruncated: boolean;
    }
  | ConversationCardBase & {
      kind: "checkpoint";
      checkpointId: number;
    }
  | ConversationCardBase & {
      kind: "intervention";
      checkpointId: number;
      actionType: "approval" | "decision_request";
      actionId: number;
    };

export interface ItemTiming {
  firstStartedAt: string | null;
  completedAt: string | null;
  statusChangedAt: string | null;
  computedAt: string;
  elapsedMs: number | null;
  activeExecutionMs: number;
  statusDurationMs: number | null;
}
