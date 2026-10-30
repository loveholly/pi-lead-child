// 改代码的工单交付以后，系统自己开草稿 PR；返工以后，更新同一个 PR（用户 2026-10-26：「如果涉及到代码变更，
// 如果工作的代码库有远程仓库默认最后都引导 agent 开 PR」）。
//
// 以前只有 open_pr：它只认用户这一轮，又只能开一次。Lead 在交付时是被事件叫醒的，开不了；返工以后没有操作能更新 PR，
// 于是 Lead 建了 #104（给 #102 开 PR）和 #116（把 #102 的返工同步到 PR #107）。
//
// 开不开只看账本里的事实，不看 Lead 的判断（这就是 2026-10-21 审查 M3 要的）：
// - 任务在 review 或 done，有隔离分支，分支上有提交、没有未提交的文件，仓库有 origin；
// - 要独立核查的工单，核查员对最新一次交付给了 PASS（done 的工单已经验收过）；
// - 用户没有说先别提 PR（setAutoPullRequest）；
// - 这次交付晚于这个功能上线的时间：以前交付的工单不会一下子都开出 PR（核心不变量：启动修复要有界）。
// 只做快进推送，不强推。同一个提交失败一次就不再试，告诉 Lead。
import type { Db } from "@pi-lead-child/store";
import { addActivity, addInbox, getItem, getLatestOutcomeSnapshot } from "@pi-lead-child/store";
import { activeRuns, deliveryWorkspace } from "./delivery-source.js";
import {
  openDeliveryPullRequest, ticketDelivery, updateDeliveryPullRequest, type PullRequestRunner,
} from "./delivery.js";
import { verificationState } from "./review-authority.js";
import { ticketRepository, workspaceRepository } from "./repository-checkout.js";

export const AUTO_PULL_REQUEST_SINCE_KEY = "delivery.auto_draft_pr.since";
const SWITCH_DECISION = "pull_request_auto";
const FAILED_DECISION = "workspace_pr_auto_failed";

export type AutoPullRequestPlan =
  | { action: "open" }
  | { action: "update"; url: string }
  | { action: "skip"; reason: string };

/** 记下功能上线的时间。已经记过时不改，返回第一次记的那个。daemon 启动时调用。 */
export function markAutoPullRequestRollout(db: Db, now = new Date()): string {
  db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO NOTHING",
  ).run(AUTO_PULL_REQUEST_SINCE_KEY, now.toISOString());
  return rolloutSince(db)!;
}

function rolloutSince(db: Db): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key=?").get(AUTO_PULL_REQUEST_SINCE_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

/** 这张工单要不要自动开 PR。缺省要；用户说「先别提 PR」时 Lead 关掉它，之后可以再打开。 */
export function setAutoPullRequest(
  db: Db, itemId: number, enabled: boolean,
  by: { actor: "user" | "lead" | "system"; reason: string; extra?: Record<string, unknown>; sessionCursor?: string },
): void {
  addActivity(db, {
    itemId, actor: by.actor, kind: "decision", ...(by.sessionCursor ? { sessionCursor: by.sessionCursor } : {}),
    payload: { decision: SWITCH_DECISION, enabled, reason: by.reason, ...by.extra },
  });
}

export function autoPullRequestEnabled(db: Db, itemId: number): boolean {
  const row = db.prepare(
    `SELECT json_extract(payload, '$.enabled') AS enabled FROM activities
     WHERE item_id=? AND kind='decision' AND json_valid(payload) AND json_extract(payload, '$.decision')=?
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId, SWITCH_DECISION) as { enabled: number | null } | undefined;
  return row ? row.enabled !== 0 : true;
}

// 这个工作区上最近一条决定（按决定的名字）。
function latestWorkspaceDecision(
  db: Db, itemId: number, workspaceId: number, names: readonly string[],
): { head?: string | null } | null {
  const row = db.prepare(
    `SELECT payload FROM activities
     WHERE item_id=? AND kind='decision' AND json_valid(payload)
       AND json_extract(payload, '$.decision') IN (${names.map(() => "?").join(",")})
       AND json_extract(payload, '$.workspaceId')=?
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId, ...names, workspaceId) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) : null;
}

interface PlanFacts { plan: AutoPullRequestPlan; workspaceId: number | null; head: string | null }

function skip(reason: string, workspaceId: number | null = null, head: string | null = null): PlanFacts {
  return { plan: { action: "skip", reason }, workspaceId, head };
}

async function planFor(db: Db, itemId: number): Promise<PlanFacts> {
  const item = getItem(db, itemId);
  if (!item || item.kind !== "task") return skip("不是任务。");
  if (!["review", "done"].includes(item.stage)) return skip("还没交付。");
  if (!autoPullRequestEnabled(db, itemId)) return skip("用户说先别提 PR。");
  const since = rolloutSince(db);
  const outcome = getLatestOutcomeSnapshot(db, itemId);
  if (!since || !outcome) return skip("没有交付记录。");
  if (Date.parse(outcome.createdAt) < Date.parse(since)) return skip("这次交付早于自动开 PR 上线。");
  if (item.stage === "review" && item.verification_policy === "independent_reviewer"
    && verificationState(db, itemId).status !== "pass") {
    return skip("等核查员对最新的交付给出 PASS。");
  }
  const workspace = deliveryWorkspace(db, itemId);
  if (!workspace) return skip("没有隔离分支。");
  if (activeRuns(db, workspace.id) > 0) return skip("还有 agent 在这个分支上工作。", workspace.id);
  // 工单写明了要改的仓库、工作区却在别的仓库：不开（2026-10-29 #161 要改 returns-skills，工作区在 aish 仓库，
  // 系统把 out/ 目录推成了 aish 仓库的 PR #126）。
  const declared = ticketRepository(db, itemId);
  const actual = declared && workspace.repo_root ? await workspaceRepository(workspace.repo_root) : null;
  if (declared && actual !== declared) {
    return skip(`工单要改的仓库是 ${declared}，工作区在 ${actual ?? "没有 origin 的仓库"}，不自动开 PR。`, workspace.id);
  }
  const delivery = await ticketDelivery(db, itemId);
  const view = delivery.workspace;
  const head = view?.head ?? null;
  if (!view || !head) return skip("找不到分支现在的提交。", workspace.id);
  if (latestWorkspaceDecision(db, itemId, workspace.id, [FAILED_DECISION])?.head === head) {
    return skip("这个提交上次没有推成，等人处理。", workspace.id, head);
  }
  if (!view.pullRequestUrl) {
    const open = delivery.actions.openPullRequest;
    return open.available ? { plan: { action: "open" }, workspaceId: workspace.id, head } : skip(open.reason ?? "现在不能开 PR。", workspace.id, head);
  }
  if (view.integration === "merged" || view.integration === "abandoned") return skip("改动已经收尾。", workspace.id, head);
  if (view.uncommittedFiles > 0) return skip("分支上还有没提交的文件。", workspace.id, head);
  const pushed = latestWorkspaceDecision(db, itemId, workspace.id, ["workspace_pr_opened", "workspace_pr_updated"]);
  if (pushed?.head === head) return skip("PR 已经是最新的。", workspace.id, head);
  return { plan: { action: "update", url: view.pullRequestUrl }, workspaceId: workspace.id, head };
}

/** 这张工单现在该开 PR、更新 PR，还是不动（不动时写原因）。 */
export async function autoPullRequestPlan(db: Db, itemId: number): Promise<AutoPullRequestPlan> {
  return (await planFor(db, itemId)).plan;
}

// PR 是要告诉用户的事：叫醒 Lead，由 Lead 决定怎么说（Lead 是常驻的个人助理，事件先交给它）。
function tellLead(db: Db, itemId: number, summary: string, payload: Record<string, unknown>): void {
  addInbox(db, {
    itemId, severity: "attention", source: "structural", summary,
    payload: { inboxKind: "workspace_pr_auto", ...payload, wakeLead: true, needsUser: true },
    lossless: true,
  });
}

export interface AutoPullRequestSweep { opened: number[]; updated: number[]; failed: number[] }

/** 看一遍交付了、有隔离分支的工单，该开 PR 的开，该更新的更新。daemon 的轮询定时调用。 */
export async function syncAutoPullRequests(
  db: Db, options: { runner?: PullRequestRunner } = {},
): Promise<AutoPullRequestSweep> {
  const result: AutoPullRequestSweep = { opened: [], updated: [], failed: [] };
  const candidates = db.prepare(
    `SELECT DISTINCT i.id FROM items i JOIN workspaces w ON w.owner_item_id = i.id
     WHERE i.kind='task' AND i.stage IN ('review','done')
       AND w.kind='isolated_child' AND w.git_worktree=1 AND w.state NOT IN ('cleaned','archived')
       AND COALESCE(w.merge_status, '') NOT IN ('merged','abandoned')
     ORDER BY i.id`,
  ).all() as Array<{ id: number }>;
  for (const { id: itemId } of candidates) {
    const { plan, workspaceId, head } = await planFor(db, itemId);
    if (plan.action === "skip") continue;
    try {
      if (plan.action === "open") {
        const { pullRequestUrl } = await openDeliveryPullRequest(db, itemId, {
          actor: "system", reason: "交付以后自动开草稿 PR", ...(options.runner ? { runner: options.runner } : {}),
        });
        tellLead(db, itemId, `工单 #${itemId} 交付了，系统开了草稿 PR：${pullRequestUrl}`, { url: pullRequestUrl, step: "open" });
        result.opened.push(itemId);
      } else {
        await updateDeliveryPullRequest(db, itemId, {
          reason: "返工交付以后更新 PR", ...(options.runner ? { runner: options.runner } : {}),
        });
        tellLead(db, itemId, `工单 #${itemId} 返工后的提交已经推到 PR，PR 描述也更新了：${plan.url}`, { url: plan.url, step: "update" });
        result.updated.push(itemId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const step = plan.action === "open" ? "没能开草稿 PR" : "没能更新 PR";
      addActivity(db, {
        itemId, actor: "system", kind: "decision",
        payload: { decision: FAILED_DECISION, workspaceId, head, step: plan.action, error: message },
      });
      tellLead(db, itemId, `工单 #${itemId} ${step}：${message}`, { step: plan.action, error: message });
      result.failed.push(itemId);
    }
  }
  return result;
}
