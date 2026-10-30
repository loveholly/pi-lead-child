// 用户本人要的 PR 评审，评审 Run 的权限清单（.scratch/lead-self-routing/spec.md B，用户 2026-10-28 选「只限这个 PR」）。
// 评审 agent 要读 PR 的描述、评论和代码，这些是别人写的。连接缺省「直接写」以后，执行者能写任何连接，PR 里的文字
// 可能让它往别处写（提示注入）。所以 create_task(template='pr_review') 建的工单，执行 Run 开始时带一份清单：
//   - 只读 PR 所在的仓库；
//   - deliver=post：只在这个 PR 上建、加评论、提交评审，结论按 Lead 派活时选的（缺省 COMMENT、REQUEST_CHANGES）；
//   - deliver=return：不写任何东西。
// 连接中心按清单检查这个 Run 的每一次调用（connections 的 hub.ts，#callGranted），写入记进 run_tool_calls。
// 这一天以前建的评审工单（模板记录里没有 deliver）不加清单，照旧。
import { computeRunGrant, GRANT_REVIEW_EVENTS, USER_PR_REVIEW_BOUND, type GrantReviewEvent } from "@pi-lead-child/protocol";
import { getRunGrant, insertRunGrant, type Db } from "@pi-lead-child/store";

const PR_REF = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d{1,7})$/u;

interface PrReviewTemplateRecord {
  pr: { owner: string; repo: string; number: number };
  deliver: "post" | "return";
  reviewEvents: GrantReviewEvent[];
}

// 工单的模板记录（Lead 的 create_task 记的 ticket_template 决定）。不是 PR 评审、或者是没有 deliver 的旧记录时为 null。
function prReviewTemplateOf(db: Db, itemId: number): PrReviewTemplateRecord | null {
  const row = db.prepare(
    `SELECT payload FROM activities WHERE item_id = ? AND kind = 'decision'
       AND json_extract(payload, '$.decision') = 'ticket_template' ORDER BY id DESC LIMIT 1`,
  ).get(itemId) as { payload: string } | undefined;
  if (!row) return null;
  let payload: { template?: unknown; pr?: unknown; deliver?: unknown; reviewEvents?: unknown };
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return null;
  }
  if (payload.template !== "pr_review" || (payload.deliver !== "post" && payload.deliver !== "return")) return null;
  const match = typeof payload.pr === "string" ? PR_REF.exec(payload.pr) : null;
  if (!match) return null;
  const events = Array.isArray(payload.reviewEvents) ? payload.reviewEvents : [];
  return {
    pr: { owner: match[1]!, repo: match[2]!, number: Number(match[3]) },
    deliver: payload.deliver,
    reviewEvents: events.filter((event): event is GrantReviewEvent => (GRANT_REVIEW_EVENTS as readonly unknown[]).includes(event)),
  };
}

/**
 * 评审工单的执行 Run 开始时，给它建清单（同一个 Run 已经有清单时不动：daemon 重启后接管的 Run）。
 * 不是 PR 评审的执行 Run 时什么都不做。返回建好的清单有没有写入。
 */
export function ensurePullRequestReviewGrant(
  db: Db, run: { itemId: number; runId: number; role: string; purpose: string },
): { created: boolean; writes: boolean } {
  if (run.role !== "executor" || run.purpose !== "execution" || getRunGrant(db, run.runId)) return { created: false, writes: false };
  const template = prReviewTemplateOf(db, run.itemId);
  if (!template) return { created: false, writes: false };
  const reviewEvents = template.deliver === "post" ? template.reviewEvents : [];
  const scope = { pullRequest: template.pr, reviewEvents };
  const { grant, dropped } = computeRunGrant({ intent: "code_review", scope, bound: USER_PR_REVIEW_BOUND, resolveLocalRepo: () => null });
  insertRunGrant(db, {
    runId: run.runId, itemId: run.itemId, grant, bound: USER_PR_REVIEW_BOUND, scope, dropped, actor: "system",
    reason: template.deliver === "post"
      ? `你要的 PR 评审：评审 agent 自己发，写入只限 ${template.pr.owner}/${template.pr.repo}#${template.pr.number}`
      : "你要的 PR 评审：只交回，不写",
  });
  return { created: true, writes: reviewEvents.length > 0 };
}
