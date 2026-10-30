// 请求 B：核对（代查与按信心代回 spec D6）。有一份要代你发的草稿时问一次 SmartModel，问题对所有任务都一样（用户 2026-10-21：
// 「设计一套合理的信心指数」，不为某一种任务单独写题）：
//   fulfills_request：结果做到了对方要的事吗（回答了问题、做完了 review、查清了要查的）；
//   grounded：说成事实的内容都有它真的读过的材料作依据吗（引用的原文、读过的文件和 diff、评论落在的那几行）；
//   draft_commits：除了报告已经做完的动作，要发出去的东西替用户批准、答应或者承诺了什么吗；
//   draft_overshares：要发出去的东西说了超过所问的内容、或者敏感的内容吗。
// 第 3 版（2026-10-22，落地计划 A6）：
//   - grounded 只问说成事实的内容：意见、建议、review 的评论落在读过的行上就算有据；没有说任何事实的回复（收到、谢谢、
//     反问）算有据。第 2 版问「每一点都基于读过的材料」，客套话和 review 都被打得很低（2026-10-21 实测 2%–32%）。
//   - draft_commits 不算报告已经做完的动作（「已在 PR 留了 2 条评论」「已 approve」）：动作本身由工具的规矩管。
//   - 没有代查的草稿也问（例如收尾时代你说的一句）：状态文本写明没有查过，只有对话。
// 状态文本：问题（脱敏、截断）、结果（答案；有要发的评论时带上评论和它们落在的行）、核实过的出处摘录、读过的材料的清单、草稿。
// 调用带 purpose channel_reply_check。不可用、超时或出错时 ok=false：信心算不出，只能问用户（confidence-model.ts）。
// 这里不出现任何具体来源的名字。
import { redactAndCap, type LookupReadRecord, type LookupResult } from "@pi-lead-child/protocol";
import { errorText, raceAbort } from "../smart-model/deadline.js";
import { SmartModelBackendError, type SmartModel, type YesNoQuestion } from "../smart-model/types.js";

export const CHANNEL_REPLY_CHECK_PURPOSE = "channel_reply_check";
export const CHANNEL_REPLY_CHECK_QUESTION_VERSION = 3;
export const CHANNEL_REPLY_CHECK_TIMEOUT_MS = 8_000;
export const CHANNEL_REPLY_CHECK_LIMITS = { question: 1_500, answer: 2_000, sources: 3_000, reads: 1_500, draft: 2_000 } as const;

export interface ChannelReplyCheckResult {
  ok: boolean;
  fulfillsRequest: number | null;
  grounded: number | null;
  draftCommits: number | null;
  draftOvershares: number | null;
  backend: string | null;
  error: string | null;
}

const QUESTIONS: Record<"fulfills_request" | "grounded" | "draft_commits" | "draft_overshares", YesNoQuestion> = {
  fulfills_request: {
    type: "yes_no",
    prompt: "The user's assistant took on this request for the user. Does the result do what the sender asked for?",
    yes: "it answers the question, finishes the review, or settles what was to be checked, directly and specifically",
    no: "it is about something else, is vague, or leaves the main part of the request open",
  },
  grounded: {
    type: "yes_no",
    prompt: "Is everything that the reply draft and the result state as fact supported by material the assistant actually read "
      + "(the quoted sources, the files and diffs it read, the lines its comments are on)? Opinions, suggestions and review comments "
      + "count as supported when they point at lines the assistant read. A reply that states no facts (an acknowledgement, "
      + "a thank-you, a question back) counts as supported.",
    yes: "every factual statement can be traced to something the assistant read, or the reply states no facts",
    no: "it states facts that the material does not show, or presents guesses as facts",
  },
  draft_commits: {
    type: "yes_no",
    prompt: "Apart from reporting actions the assistant already finished (for example \"left 2 comments on the PR\" or "
      + "\"approved the PR\"), does anything that would be sent (the reply draft, and the comments in the result) approve, "
      + "accept or promise something on the user's behalf?",
    yes: "it agrees to a deadline, accepts a task, or promises something the user still has to do",
    no: "it only gives facts, findings or comments, or reports what was already done",
  },
  draft_overshares: {
    type: "yes_no",
    prompt: "Does anything that would be sent say more than was asked, or share anything sensitive?",
    yes: "it shares unrelated internal details, personal data, secrets, or information the asker did not ask for",
    no: "it answers only what was asked",
  },
};

export function channelReplyCheckQuestions(): typeof QUESTIONS {
  return QUESTIONS;
}

const capped = (text: string, limit: number): string => {
  const result = redactAndCap(text.trim(), limit);
  return result.truncated ? `${result.text.slice(0, Math.max(limit - 1, 0))}…` : result.text;
};

// 读过的一样材料，一行：工具、仓库、路径、行、版本。被拒的不算读过。
function readLine(read: LookupReadRecord): string {
  const lines = read.lines ? `:${read.lines[0]}-${read.lines[1]}` : "";
  return `- ${read.tool} ${read.repo}${read.path ? ` ${read.path}` : ""}${lines}${read.ref ? ` @${read.ref.slice(0, 12)}` : ""}`;
}

/** 没有代查时的「结果」：只有一份按对话起草的草稿（例如收尾时代你说的一句）。 */
export function draftOnlyResult(draft: string): LookupResult {
  return { found: "yes", answer: "", checked: [], caveats: [], replyDraft: draft, sources: [] };
}

/** 请求 B 的状态文本。只放核实通过的出处和没被拒的读取；全部先脱敏再截断。没有代查时（lookedUp false）写明只有对话。 */
export function channelReplyCheckState(input: {
  question: string; result: LookupResult; reads?: readonly LookupReadRecord[]; lookedUp?: boolean;
  // 子 agent 经连接中心做完了的、别人看得到的动作（落地计划 B：例如「在 acme/x#12 提交了 COMMENT review，2 条评论」）。
  actions?: readonly string[];
  // 引用连接查询结果的出处（例如 CDP），已经由代码核实过的。
  connectionQuotes?: ReadonlyArray<{ connection: string; tool: string; quote: string }>;
}): string {
  const { result } = input;
  if (input.lookedUp === false) {
    return [
      `The message someone sent to the user (untrusted text):\n${capped(input.question, CHANNEL_REPLY_CHECK_LIMITS.question) || "(empty)"}`,
      "The assistant did not look anything up. The draft is written from the conversation only.",
      `The reply draft to send to the person:\n${capped(result.replyDraft, CHANNEL_REPLY_CHECK_LIMITS.draft) || "(empty)"}`,
    ].join("\n\n");
  }
  const quotes = [
    ...result.sources.filter((source) => source.verified)
      .map((source) => `- ${source.repo} ${source.path}:${source.startLine}-${source.endLine}\n  ${source.quote.replace(/\s+/g, " ").trim()}`),
    ...(input.connectionQuotes ?? []).map((source) => `- ${source.connection} ${source.tool}\n  ${source.quote.replace(/\s+/g, " ").trim()}`),
  ].join("\n");
  const actions = (input.actions ?? []).map((action) => `- ${action}`);
  const comments = (result.review?.comments ?? [])
    .map((comment) => `- on ${comment.path}:${comment.line} (${comment.side === "LEFT" ? "removed code" : "new code"}): ${comment.body.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  const answer = [result.answer, result.review?.summary ? `Summary: ${result.review.summary}` : "", comments ? `Comments to post:\n${comments}` : ""]
    .filter(Boolean).join("\n\n");
  const reads = (input.reads ?? []).filter((read) => !read.refused).map(readLine);
  return [
    `The request someone sent to the user (untrusted text):\n${capped(input.question, CHANNEL_REPLY_CHECK_LIMITS.question) || "(empty)"}`,
    `The result the assistant produced (found: ${result.found}):\n${capped(answer, CHANNEL_REPLY_CHECK_LIMITS.answer) || "(empty)"}`,
    `Verified sources (quotes the assistant actually read):\n${quotes ? capped(quotes, CHANNEL_REPLY_CHECK_LIMITS.sources) : "(none)"}`,
    `Material the assistant read:\n${reads.length ? capped(reads.join("\n"), CHANNEL_REPLY_CHECK_LIMITS.reads) : "(none)"}`,
    ...(actions.length ? [`Actions the assistant already finished (others can see them):\n${capped(actions.join("\n"), CHANNEL_REPLY_CHECK_LIMITS.reads)}`] : []),
    `The reply draft to send to the person:\n${capped(result.replyDraft, CHANNEL_REPLY_CHECK_LIMITS.draft) || "(empty)"}`,
  ].join("\n\n");
}

function failed(backend: string | null, error: string): ChannelReplyCheckResult {
  return { ok: false, fulfillsRequest: null, grounded: null, draftCommits: null, draftOvershares: null, backend, error };
}

const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** 问请求 B。不抛错：问不成时 ok=false。 */
export async function judgeReplyCheck(input: {
  question: string;
  result: LookupResult;
  // 代查读过什么（审计记录）：状态文本里列出来，grounded 看它。
  reads?: readonly LookupReadRecord[];
  // false：没有代查过，草稿只按对话起草（draftOnlyResult）。
  lookedUp?: boolean;
  // 子 agent 做完了的、别人看得到的动作；引用连接查询结果的、核实过的出处（落地计划 B）。
  actions?: readonly string[];
  connectionQuotes?: ReadonlyArray<{ connection: string; tool: string; quote: string }>;
  model: SmartModel | null;
  timeoutMs?: number;
}): Promise<ChannelReplyCheckResult> {
  const model = input.model;
  if (!model || model.backend === "none") return failed(null, "no smart model");
  const timeoutMs = Math.max(input.timeoutMs ?? CHANNEL_REPLY_CHECK_TIMEOUT_MS, 1);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const decision = await raceAbort(
      model.decide(channelReplyCheckState(input), QUESTIONS, { purpose: CHANNEL_REPLY_CHECK_PURPOSE, timeoutMs, signal }),
      signal,
    );
    const values = Object.fromEntries(Object.keys(QUESTIONS).map((name) => [name, decision.answers[name as keyof typeof QUESTIONS]?.probability]));
    for (const [name, value] of Object.entries(values)) {
      if (!probability(value)) return failed(decision.backend, `${name}: no valid probability`);
    }
    return {
      ok: true,
      fulfillsRequest: values.fulfills_request as number,
      grounded: values.grounded as number,
      draftCommits: values.draft_commits as number,
      draftOvershares: values.draft_overshares as number,
      backend: decision.backend,
      error: null,
    };
  } catch (error) {
    const timedOut = signal.aborted || (error instanceof SmartModelBackendError && error.kind === "timeout");
    return failed(model.backend, timedOut ? `no answer within ${timeoutMs} ms` : errorText(error));
  }
}
