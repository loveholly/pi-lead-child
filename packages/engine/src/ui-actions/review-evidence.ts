// 补挂核查证据（工单 #503，protocol 的 review-evidence.ts）：一次已经结束的核查，截图留在它的工作区里，工单详情里看不到。
// 一个操作 attach_evidence：页面入口（POST /v1/actions/review_attempt/<核查编号>/attach_evidence）和 Lead 的 perform_action
// 调这同一个定义，再调核查员自己用的同一个函数（agent-tools/review-evidence.ts 的 attachReviewEvidence）。
//   · 只读那次核查的工作区里的图片：越界、指向区外的符号链接、敏感文件、不是图片的文件都拒绝。
//   · 不重跑核查，不改交付、核查的结论和工单的阶段：只多几行证据。
//   · lead_allowed，不改规则：Lead 在哪一轮都能做。核查还在跑时不用它，让核查员自己挂。
import { existsSync } from "node:fs";

import type { AttachReviewEvidenceRequest } from "@pi-lead-child/protocol";
import type { Run } from "@pi-lead-child/core";
import { getItem } from "@pi-lead-child/store";

import {
  attachReviewEvidence, ReviewEvidenceError, reviewEvidenceToolResult, reviewWorkspaceRoot,
  type AttachReviewEvidenceResult,
} from "../agent-tools/review-evidence.js";
import { AVAILABLE, unavailable } from "../ticket-actions/types.js";
import { UiActionError, type UiActionDefinition, type UiActionTargetKind } from "./types.js";

const WHERE = "会话里告诉 Lead 要补挂哪次核查的哪几张截图（工单详情里还没有这个按钮）";

export interface ReviewAttemptTarget {
  run: Run;
  ticketTitle: string;
  // 那次核查的工作区（读截图的地方）；没有时为 null。
  root: string | null;
}

function load(db: Parameters<UiActionTargetKind<ReviewAttemptTarget>["load"]>[0]["db"], id: string): ReviewAttemptTarget | null {
  if (!/^[1-9]\d{0,15}$/.test(id)) return null;
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(Number(id)) as Run | undefined;
  if (!run || run.role !== "reviewer") return null;
  return { run, ticketTitle: getItem(db, run.item_id)?.title ?? "", root: reviewWorkspaceRoot(db, run) };
}

function ended(target: ReviewAttemptTarget): boolean {
  return !["starting", "running"].includes(target.run.state);
}

export const REVIEW_ATTEMPT_TARGET: UiActionTargetKind<ReviewAttemptTarget> = {
  type: "review_attempt",
  label: "一次核查",
  idHint: "核查员的执行记录编号（attempt id，get_ticket 的执行记录里 role 是 reviewer 的那几次）",
  load: (env, id) => load(env.db, id),
  name: (target) => `工单 #${target.run.item_id} 的第 ${target.run.id} 号核查`,
  describe: (target) => ({
    ticketId: target.run.item_id,
    ticketTitle: target.ticketTitle,
    state: target.run.state,
    ended: ended(target),
    workspaceAvailable: Boolean(target.root && existsSync(target.root)),
  }),
};

export const REVIEW_ATTEMPT_ACTIONS = {
  attach_evidence: {
    target: "review_attempt", id: "attach_evidence", label: "补挂核查截图", scope: "tickets:create",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: WHERE,
    hint: "一次已经结束的核查，截图留在它的工作区里、工单详情里看不到时，用它把截图补挂成「核查证据」。"
      + "files 每张图一项：path 是图片在那次核查工作区里的路径（相对路径或工作区里的绝对路径），"
      + "criteria 是它证明的验收标准 id（工单有验收标准时至少一条），caption 是一句说明（可选）。"
      + "只收 PNG、JPEG、GIF、WebP，单张最大 10 MB，一次最多 10 张；工作区外的路径、指向区外的符号链接和像密钥的文件会被拒绝。"
      + "不重跑核查，不改交付、核查的结论和工单的阶段。核查还在跑时不用它：核查员自己用 attach_review_evidence 挂。",
    defaultReason: "补挂了核查截图",
    available: (target) => {
      if (!ended(target)) return unavailable("这次核查还在跑：让核查员自己用 attach_review_evidence 挂截图");
      if (!target.root || !existsSync(target.root)) return unavailable("这次核查的工作区已经清掉了，里面的截图取不到");
      return AVAILABLE;
    },
    run: async (run): Promise<AttachReviewEvidenceResult> => {
      const dataDir = run.env.services.dataDir;
      if (!dataDir) throw new UiActionError("unavailable", "附件的存储还没有启动");
      const input = run.input as AttachReviewEvidenceRequest;
      const addedBy = run.by.actor === "lead" ? "lead" : "user";
      try {
        return await attachReviewEvidence(run.db, dataDir, { runId: run.target.run.id, files: input.files, addedBy, now: run.env.now });
      } catch (error) {
        if (error instanceof ReviewEvidenceError) {
          throw new UiActionError(error.code === "not_found" ? "not_found" : "invalid_input", error.message);
        }
        throw error;
      }
    },
    forLead: (_run, result) => ({
      ...reviewEvidenceToolResult(result as AttachReviewEvidenceResult),
      next: "用户在工单详情的「核查证据」里看得到这些图。核查的结论和工单的状态没有变。",
    }),
    detail: (_run, result) => {
      const attached = result as AttachReviewEvidenceResult;
      return {
        ticketId: attached.ticketId,
        added: attached.results.filter((entry) => entry.added).map((entry) => entry.evidence.id),
        alreadyAttached: attached.results.filter((entry) => !entry.added).map((entry) => entry.evidence.id),
      };
    },
  },
} satisfies Record<string, UiActionDefinition<ReviewAttemptTarget, any>>;
