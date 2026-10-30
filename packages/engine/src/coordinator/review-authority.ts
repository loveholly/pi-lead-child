// ── review 阶段的事实层（工单 #66 复盘）───────────────────────────────────────
//
// #66 暴露的不是某一处判断写错了，而是"stage=review 到底意味着什么"这件事根本没有
// 单一事实源：delegated-review 自己数返工次数决定还派不派发，control-plane 自己看
// review_verdicts 决定投什么标签，两边算的是同一件事的不同一半，谁也不知道对方的结论。
// 于是 #66 在界面上写着"待验收"，旁边就是"验收通过"，而返工额度 1/1 已经花掉、
// reviewer 的 FAIL 早已过期。
//
// 更正（2026-10-13）：早先这里写"最后一个 executor Run 连成果快照都登记不上"。那是误诊。
// #66 最后一次交付 Run #49 登记了成果快照 #2；之后的 Run #50/#51 是用户提问
// （purpose=conversation）。真正卡住的原因是 Run #49 由"开始执行"直接启动、不经派发队列，
// 结束后没有任何代码请求独立核查。"哪个 Run 算交付"的规则见 pipeline/delivery-run.ts。
//
// 这个模块把三件事收成可被两边共用、也可被直接测到的纯查询：
//   1. 当前**真实**验证状态（PASS / FAIL / 未知）——过期的裁决一律算未知；
//   2. 返工额度用掉了几次、上限是多少、每一次是因为什么失败的；
//   3. runtime 自我恢复终态是否失败（有 Run 结束了但成果快照登记不上）。
import type { Db } from "@pi-lead-child/store";
import type { DelegationPolicy } from "@pi-lead-child/store";
import type { Item, Run } from "@pi-lead-child/core";
import { deliveryRunBefore, isDeliveryRun, latestDeliveryRunId } from "../pipeline/delivery-run.js";

export const DEFAULT_REVIEW_REWORK_CYCLES = 1;

export interface ReviewVerdictRow {
  run_id: number;
  verdict: "pass" | "fail";
  evidence: string;
  pre_hash: string | null;
  post_hash: string | null;
}

export type VerificationStatus = "pass" | "fail" | "unknown";

export interface VerificationState {
  status: VerificationStatus;
  /** 当前有效裁决；过期或从未有过时为 null。 */
  current: ReviewVerdictRow | null;
  /** 最后一次裁决，无论是否过期——它是"未知"的解释，不是"未知"的反例。 */
  latest: ReviewVerdictRow | null;
  /** latest 为何过期：它之后又跑过的那次交付，或者改过工作区的那个工单对话 Run。 */
  supersededByRunId: number | null;
}

export function latestReviewVerdict(db: Db, itemId: number): ReviewVerdictRow | null {
  return (db.prepare(
    `SELECT run_id, verdict, evidence, pre_hash, post_hash
     FROM review_verdicts
     WHERE item_id=?
     ORDER BY run_id DESC LIMIT 1`,
  ).get(itemId) as ReviewVerdictRow | undefined) ?? null;
}

/** 对话 Run 改过被核查的工作区时记下的 decision（pipeline/review-currency.ts）。 */
export const WORKSPACE_CHANGED_AFTER_REVIEW = "workspace_changed_after_review";

/**
 * 核查结论的有效边界：在这个 Run 之前（含）写下的结论都已过期。它是最新的交付，或者之后
 * 改过被核查的工作区的那个工单对话 Run（release review 5），取较新的一个。
 */
export function verificationBoundaryRunId(db: Db, itemId: number): number | null {
  const delivery = latestDeliveryRunId(db, itemId);
  const { run_id: chat } = db.prepare(
    `SELECT MAX(run_id) AS run_id FROM activities
     WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')=?`,
  ).get(itemId, WORKSPACE_CHANGED_AFTER_REVIEW) as { run_id: number | null };
  if (delivery === null) return chat;
  if (chat === null) return delivery;
  return Math.max(delivery, chat);
}

/**
 * 一次 reviewer 裁决只对它当时看到的那份成果有效。之后又有一次交付，它描述的东西
 * 就已经不存在了——那不是"仍然 FAIL"，也不是"仍然 PASS"，是**未知**。
 *
 * "交付"按 delivery-run.ts 的规则算：用户在工单里提问（conversation）或补交成果
 * （outcome_repair）都不会让裁决过期。例外是对话改了被核查的工作区（verificationBoundaryRunId）。
 */
export function verificationState(db: Db, itemId: number): VerificationState {
  const latest = latestReviewVerdict(db, itemId);
  if (!latest) {
    return { status: "unknown", current: null, latest: null, supersededByRunId: null };
  }
  const boundaryRunId = verificationBoundaryRunId(db, itemId);
  if (boundaryRunId !== null && latest.run_id <= boundaryRunId) {
    return { status: "unknown", current: null, latest, supersededByRunId: boundaryRunId };
  }
  return { status: latest.verdict, current: latest, latest, supersededByRunId: null };
}

export function currentReviewVerdict(db: Db, itemId: number): ReviewVerdictRow | null {
  return verificationState(db, itemId).current;
}

export type ReviewerProgress =
  | { state: "running" }
  | { state: "queued" }
  | { state: "suspended"; reason: string | null };

/**
 * 独立核查走到哪一步了。数据里本来就是三种状态，以前被压成一个布尔值，卡片于是把排队写成
 * "正在进行"：
 *   · running：有 reviewer Run 在启动或运行，或者请求已被认领（Run 正在创建）；
 *   · suspended：请求在排队，但 dispatcher 把它挂起了（例如 runtime 不可用），suspended_reason 写着原因；
 *   · queued：请求在排队，等 dispatcher 认领。
 * 和 reviewer agent 的对话（purpose=conversation）不是核查，不算在内。
 */
export function reviewerProgress(db: Db, itemId: number): ReviewerProgress | null {
  const running = db.prepare(
    `SELECT 1 FROM runs
     WHERE item_id=? AND role='reviewer' AND purpose='review' AND state IN ('starting','running')
     LIMIT 1`,
  ).get(itemId);
  if (running) return { state: "running" };
  const requests = db.prepare(
    `SELECT id, item_id, state, suspended_reason, idempotency_key, retry_of_run_id FROM dispatch_requests
     WHERE item_id=? AND role='reviewer' AND state IN ('pending','claimed','started')
     ORDER BY id DESC`,
  ).all(itemId) as Array<ReviewRequestRow & { state: string; suspended_reason: string | null }>;
  // 过期的请求不会再被认领（dispatcher 下一次 claim 时作废它），不能让卡片一直写"排队中"。
  const request = requests.find((row) => row.state !== "pending" || staleReviewRequestReason(db, row) === null);
  if (!request) return null;
  if (request.state !== "pending") return { state: "running" };
  if (request.suspended_reason) return { state: "suspended", reason: request.suspended_reason };
  return { state: "queued" };
}

export interface ReviewRequestRow {
  id: number;
  item_id: number;
  idempotency_key: string | null;
  retry_of_run_id: number | null;
}

/** 用户派发的核查（trigger=user-review）是为哪一次交付建的：幂等键里写着（user-actions.ts 的 requestReview）。 */
export function userReviewDeliveryRunId(row: Pick<ReviewRequestRow, "item_id" | "idempotency_key">): number | null {
  const match = row.idempotency_key?.match(/^user-review:(\d+):delivery-run:(\d+):\d+$/);
  return match && Number(match[1]) === row.item_id ? Number(match[2]) : null;
}

/**
 * 一条核查请求是为哪一次交付建的；看不出来时为 null。
 *   · 建请求时记下的交付（dispatch.ts 在 dispatch_requested 活动里写 reviewDeliveryRunId）；
 *     下面几条只给这之前建的旧请求用：
 *   · user-review：幂等键里写着交付；
 *   · automatic-review：幂等键里写着触发它的 executor Run（automatic-review.ts）。那可能是一次
 *     修复回合，它补交的是它之前那次交付的成果；
 *   · 重试：指向失败的 reviewer Run，它核查的是它之前那次交付。
 * 旧的 Lead 请求（spawn-suspended）和工单 agent 请求（ticket-agent-continuation）看不出来，
 * 由新交付开始时的作废兜住（dispatch.ts 的 expireReviewRequestsForNewDelivery）。
 */
function reviewRequestDeliveryRunId(db: Db, row: ReviewRequestRow): number | null {
  const recorded = db.prepare(
    `SELECT json_extract(payload, '$.reviewDeliveryRunId') AS delivery FROM activities
     WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')='dispatch_requested'
       AND json_extract(payload, '$.dispatchRequestId')=?
     ORDER BY id DESC LIMIT 1`,
  ).get(row.item_id, row.id) as { delivery: number | null } | undefined;
  if (typeof recorded?.delivery === "number") return recorded.delivery;
  const user = userReviewDeliveryRunId(row);
  if (user !== null) return user;
  const automatic = row.idempotency_key?.match(/^automatic-review:(\d+):executor-run:(\d+)$/);
  if (automatic && Number(automatic[1]) === row.item_id) {
    const runId = Number(automatic[2]);
    const run = db.prepare("SELECT role, purpose FROM runs WHERE id=? AND item_id=?").get(runId, row.item_id) as
      Pick<Run, "role" | "purpose"> | undefined;
    if (run) return isDeliveryRun(run) ? runId : deliveryRunBefore(db, row.item_id, runId);
  }
  return row.retry_of_run_id === null ? null : deliveryRunBefore(db, row.item_id, row.retry_of_run_id);
}

/**
 * 一条还在排队的核查请求是不是过期了；过期时返回原因。
 *
 * reviewer 请求只在 review 里建：用户派发要先有未核查的交付，自动核查要求工单在 review，
 * Lead 和工单 agent 建请求之前都过 run-gate，而 reviewer 只能在 review 里跑。交付 Run 只能在
 * review 外跑。所以一条请求总是为"建它时最新的那次交付"而建，请求本身就是核查这次交付的授权
 * （dispatch.ts 的 purposeReady）。下面任何一条成立，它要核查的东西就不在了。留着它，下一次
 * 交付进 review 时它会被认领成对新交付的核查——没有人要过那一次，自动核查也会再派一次。
 */
export function staleReviewRequestReason(db: Db, row: ReviewRequestRow): string | null {
  const item = db.prepare("SELECT stage FROM items WHERE id=?").get(row.item_id) as { stage: string } | undefined;
  if (!item) return `item #${row.item_id} not found`;
  if (item.stage !== "review") return `工单已离开 review（现在是 ${item.stage}）`;
  const latest = latestDeliveryRunId(db, row.item_id);
  const target = reviewRequestDeliveryRunId(db, row);
  if (target !== null && target !== latest) {
    return `要核查的交付 Run #${target} 已经不是最新的交付（Run #${latest ?? "-"}）`;
  }
  if (verificationState(db, row.item_id).current) return "最新的交付已经有了有效的核查结论";
  return null;
}

/** 有没有 reviewer 正在跑、已经排上队，或排着队但被挂起。 */
export function reviewerInFlight(db: Db, itemId: number): boolean {
  return reviewerProgress(db, itemId) !== null;
}

export type ReworkCycleSource = "delegated_automation" | "user_authorized" | "legacy_automation";

export interface ReworkCycle {
  cycle: number;
  source: ReworkCycleSource;
  reviewerRunId: number | null;
  at: string;
  /** 这一轮是因为什么失败的——reviewer 报告优先，其次是决策自带的 reason。 */
  summary: string;
}

interface ReworkActivityRow {
  id: number;
  created_at: string;
  decision: string;
  reason: string | null;
  reviewer_report: string | null;
  reviewer_run_id: number | null;
}

function condense(text: string | null, limit = 220): string {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "（未记录失败原因）";
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

/**
 * Lead 的返工额度只数属于这份授权的返工：
 *   · 自动化在授权范围内发起的返工（delegated_review_rework，带 delegationPolicyId）；
 *   · 用户在授权面板里点"授权并返工"时顺带启动的那一次（#66 的授权与第一次返工是同一个动作，
 *     不算它，界面上就会出现"已返工一次，计数器 0/1"这种对不上的账）。
 * 用户自己点"手动返工"不算：那是用户的决定，不是 Lead 在授权范围内的自动返工（2026-10-13 用户确认）。
 * 两者只靠 delegationPolicyId 区分；授权时那一次的旧数据由迁移 v35 补上了编号（store/data-corrections.ts）。
 *
 * policy 为 null 时保留旧口径（无授权时的系统自动返工），因为那条路径根本没有额度概念。
 */
export function reworkCycles(
  db: Db,
  itemId: number,
  policy: DelegationPolicy | null,
): ReworkCycle[] {
  const rows = policy === null
    ? db.prepare(
        `SELECT id, created_at,
                json_extract(payload, '$.decision') AS decision,
                json_extract(payload, '$.reason') AS reason,
                json_extract(payload, '$.reviewerReport') AS reviewer_report,
                json_extract(payload, '$.reviewerRunId') AS reviewer_run_id
         FROM activities
         WHERE item_id=? AND kind='decision'
           AND json_extract(payload, '$.decision')='review_failure_auto_rework'
           AND json_type(payload, '$.delegationPolicyId') IS NULL
         ORDER BY id`,
      ).all(itemId) as ReworkActivityRow[]
    : db.prepare(
        `SELECT id, created_at,
                json_extract(payload, '$.decision') AS decision,
                json_extract(payload, '$.reason') AS reason,
                json_extract(payload, '$.reviewerReport') AS reviewer_report,
                json_extract(payload, '$.reviewerRunId') AS reviewer_run_id
         FROM activities
         WHERE item_id=? AND kind='decision'
           AND (
             (json_extract(payload, '$.decision')='delegated_review_rework'
               AND json_extract(payload, '$.delegationPolicyId')=?)
             OR (json_extract(payload, '$.decision')='rework_dispatch_requested'
               AND json_extract(payload, '$.delegationPolicyId')=?)
           )
         ORDER BY id`,
      ).all(itemId, policy.id, policy.id) as ReworkActivityRow[];

  return rows.map((row, index) => ({
    cycle: index + 1,
    source: row.decision === "delegated_review_rework"
      ? "delegated_automation"
      : row.decision === "rework_dispatch_requested"
        ? "user_authorized"
        : "legacy_automation",
    reviewerRunId: row.reviewer_run_id ?? null,
    at: row.created_at,
    summary: condense(row.reviewer_report ?? row.reason),
  }));
}

export interface ReworkExhaustion {
  cyclesUsed: number;
  /** null = 这张工单上根本没有"自动返工额度"这回事（没有授权，或授权不含自动返工）。 */
  maxCycles: number | null;
  exhausted: boolean;
  cycles: ReworkCycle[];
}

export function reworkAuthority(
  item: Pick<Item, "rework_policy">,
  policy: DelegationPolicy | null,
): DelegationPolicy | null {
  return policy && item.rework_policy === "automatic" && policy.rework_policy === "automatic"
    ? policy
    : null;
}

export function reworkExhaustion(
  db: Db,
  item: Pick<Item, "id" | "rework_policy">,
  policy: DelegationPolicy | null,
): ReworkExhaustion {
  const authority = reworkAuthority(item, policy);
  const cycles = reworkCycles(db, item.id, authority);
  const maxCycles = authority === null
    ? null
    : authority.max_rework_cycles ?? DEFAULT_REVIEW_REWORK_CYCLES;
  return {
    cyclesUsed: cycles.length,
    maxCycles,
    exhausted: maxCycles !== null && cycles.length >= maxCycles,
    cycles,
  };
}

export interface OutcomeRecoveryFailure {
  runId: number;
}

/**
 * "runtime 自己从 session 输出里恢复终态"这条路走失败了。
 *
 * 判据是两条同时成立的账本事实，不是文本匹配：最后一次交付 Run 没有成果快照，
 * 且系统已经为它写下过 outcome-registration-missing 的 blocked checkpoint。inbox 是否
 * 已被 Lead 消费掉不参与判断——Lead 读没读过，不改变"这个 Run 交不出成果"这件事。
 * 对话 Run 不是交付：#66 的 Run #51 是一次提问，它没有成果快照说明不了交付缺了什么。
 */
export function outcomeRecoveryFailure(db: Db, itemId: number): OutcomeRecoveryFailure | null {
  const runId = latestDeliveryRunId(db, itemId);
  if (runId === null) return null;
  const registered = db.prepare(
    "SELECT 1 FROM outcome_snapshots WHERE executor_run_id=? LIMIT 1",
  ).get(runId);
  if (registered) return null;
  const recorded = db.prepare(
    "SELECT 1 FROM checkpoints WHERE idempotency_key=? LIMIT 1",
  ).get(`outcome-registration-missing:${runId}`);
  return recorded ? { runId } : null;
}

/**
 * 自动化是否已经因为返工用尽而显式停手（而不是"额度刚好用满，但流程还在往前走"）。
 * afterRunId：只认这个 Run 之后的停手。停手记在当时的 reviewer Run 上；它不比最新的交付新，说的就是一份已经被取代的成果
 * （发布评审：reviewDeadlock 读的是历史，不是当前状态）。
 */
export function reworkExhaustionEscalated(db: Db, itemId: number, afterRunId: number | null = null): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM activities
     WHERE item_id=? AND kind='decision'
       AND json_extract(payload, '$.decision') IN
           ('delegated_review_escalate','review_failure_auto_escalate')
       AND json_extract(payload, '$.reason') LIKE '%rework cycles exhausted%'
       AND (? IS NULL OR run_id > ?)
     LIMIT 1`,
  ).get(itemId, afterRunId, afterRunId));
}

export interface ReviewDeadlock {
  reworkExhausted: boolean;
  outcomeRecoveryFailed: boolean;
}

/**
 * stage=review 却根本不在等人验收的那一类。
 *
 * 三个前提缺一不可地组合成一句话：**没有 reviewer 在路上**，而且要么这个 Run 交不出
 * 成果（恢复失败），要么返工额度已经用尽且当前验证不是"正在等新一轮核查"。
 * 特意不把"额度刚好用满"单独算作卡死：返工跑完、executor 交付、reviewer 还没排上队的
 * 那几秒里，额度同样是满的，而那是正常流程。
 */
export function reviewDeadlock(
  db: Db,
  item: Pick<Item, "id" | "rework_policy">,
  input: {
    verification: VerificationState;
    exhaustion: ReworkExhaustion;
  },
): ReviewDeadlock | null {
  if (reviewerInFlight(db, item.id)) return null;
  const outcomeRecoveryFailed = outcomeRecoveryFailure(db, item.id) !== null;
  // 进入卡死态的门槛比描述它更严：额度满了但流程还在往前走（返工刚交付、reviewer 还没排上队）
  // 不算卡死，所以这里额外要求"当前核查确实是 FAIL"或"自动化已经显式停手"。
  // 只看当前这份交付：最新的核查已经通过就不是卡死；停手只认最新交付之后的那一次。
  const halted = input.exhaustion.exhausted
    && input.verification.status !== "pass"
    && (input.verification.status === "fail"
      || reworkExhaustionEscalated(db, item.id, verificationBoundaryRunId(db, item.id)));
  if (!outcomeRecoveryFailed && !halted) return null;
  // 一旦确认卡死，额度就照实说：#66 是"额度用尽"和"恢复失败"同时成立，
  // 只报其中一件会让用户以为另一件还有余地。
  return { reworkExhausted: input.exhaustion.exhausted, outcomeRecoveryFailed };
}

export interface UnreviewedDelivery {
  /** 等着被核查的那次交付。 */
  deliveryRunId: number;
}

/**
 * 一次交付进了 review，没有任何核查在路上——用户可以手动派一个独立核查。
 *
 * 对要求独立核查的工单，这就是工单 #66 真正卡住的样子：自动核查只在 Run 结束的那一刻请求
 * （pipeline/automatic-review.ts），不扫描历史，早就卡住的旧工单要靠这里被看见，控制面把它
 * 投影成"独立核查未派发"。对由用户自己验收的工单，它只是一个可选动作：先派核查再验收。
 *
 * 下面几种情况核查马上会来，不算卡住：reviewer 在跑或已排队；交付 Run 的 child 还在收尾
 * （liveItemIds），manager 会在收尾时请求；认领还没被 orchestrator 收尾，它也会请求。
 * 最后一次交付没有成果可核查时，那是另一种卡住（outcomeRecoveryFailure），不在这里。
 */
export function unreviewedDelivery(
  db: Db,
  item: Pick<Item, "id" | "kind" | "stage" | "verification_policy">,
  options: { liveItemIds?: readonly number[] } = {},
): UnreviewedDelivery | null {
  if (item.kind !== "task" || item.stage !== "review") return null;
  const deliveryRunId = latestDeliveryRunId(db, item.id);
  if (deliveryRunId === null) return null;
  const run = db.prepare("SELECT state FROM runs WHERE id=?").get(deliveryRunId) as { state: string } | undefined;
  if (run?.state !== "finished") return null;
  if (verificationState(db, item.id).current) return null;
  if (reviewerInFlight(db, item.id)) return null;
  if (options.liveItemIds?.includes(item.id)) return null;
  if (db.prepare("SELECT 1 FROM dispatch_claims WHERE item_id=? LIMIT 1").get(item.id)) return null;
  if (outcomeRecoveryFailure(db, item.id)) return null;
  return { deliveryRunId };
}

/** Shared query boundary for Lead, daemon and Companion projections. */
export class ReviewAuthorityService {
  constructor(private readonly db: Db) {}
  verification(itemId: number): VerificationState { return verificationState(this.db, itemId); }
  exhaustion(item: Pick<Item, "id" | "rework_policy">, policy: DelegationPolicy | null): ReworkExhaustion {
    return reworkExhaustion(this.db, item, policy);
  }
  deadlock(item: Pick<Item, "id" | "rework_policy">, policy: DelegationPolicy | null): ReviewDeadlock | null {
    const verification = this.verification(item.id);
    return reviewDeadlock(this.db, item, { verification, exhaustion: this.exhaustion(item, policy) });
  }
}
