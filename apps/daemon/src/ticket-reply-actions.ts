// 工单 agent 回复下面的动作按钮（2026-10-19）。用户：「这种自然语言对话永远不要用正则来做匹配啊，明明有快模型」。
//
// 以前 companion 的 replyActions.ts 用关键词表（「核查」「验收」「返工」……）和「最后一段有问号」，判断回复在问你
// 要不要做哪个动作。现在 daemon 在工单 agent 的一轮回答结束时（最终文字定下来以后）问 SmartModel：这段回复是不是
// 在等你决定要不要做下面这些动作，分别是哪几个。动作是固定的一组 id（protocol 的 TICKET_REPLY_ACTION_IDS），
// 每个动作一个 yes_no 问题，放在同一次 decide 调用里。
//
// 用的是 Lead 会话的 SmartModel（packages/lead 的 smart-model.ts：决策模型优先，LLM 兜底），不另建一套。
// 它每次调用写一条 decision_model.called 事件（purpose 是 ticket_reply_actions），get_system_usage 按用途统计。
//
// 送出去的文字：先 redactSecretText 遮住密钥，再只取最后 REPLY_TAIL_CHARS 个字。问你的话通常在回复的末尾。
//
// 结果记成一条事件（store 的 recordTicketReplyActions），再推一条 snapshot.required，客户端重取这张工单的对话。
// companion 只显示「模型说在问」并且「工单现在确实能做」的动作：按钮来自工单当前的选项，模型只决定显示哪几个。
//
// 失败（没有 SmartModel、超时、出错）：不记结果，不显示按钮（决策卡上照样有真正的按钮），记一行日志。
// 判断是异步的：不挡回答的送达，按钮可以晚一点出现。
import type { SmartModel, YesNoQuestion } from "@pi-lead-child/engine";
import {
  redactSecretText, TICKET_REPLY_ACTION_IDS, TICKET_REPLY_ACTIONS_RESOURCE, type TicketReplyActionId,
} from "@pi-lead-child/protocol";
import { recordTicketReplyActions, type Db, type PublishGatewayEventInput } from "@pi-lead-child/store";

export const REPLY_ACTIONS_PURPOSE = "ticket_reply_actions";

// 「是」的概率至少要到这里才显示按钮。宁可少显示：按钮少了，决策卡上还有；按钮多了，会诱导你点一个回复没在问的动作。
//   · Jev 回的是校准过的概率。0.75 要求模型明确认为回复在问，0.5 上下拿不准的不显示。
//   · LLM 兜底只回是或否，概率是固定的 (1 ± LLM_FIXED_CONFIDENCE) / 2，现在是 0.8 和 0.2。阈值不能高过 0.8，
//     否则 Jev 不可用时永远没有按钮（测试里钉住了这一条）。
export const REPLY_ACTION_THRESHOLD = 0.75;
// 只送回复的最后这么多个字。
export const REPLY_TAIL_CHARS = 2_000;
// 整次判断（包括 Jev 失败后 LLM 兜底）最多等这么久。Jev 的缺省超时是 5 秒，LLM 是 20 秒。
export const REPLY_ACTIONS_DEADLINE_MS = 30_000;

// 每个动作对工单意味着什么。和 companion 决策卡上的选项一致（ticketState.ts）。
const ACTION_MEANINGS: Record<TicketReplyActionId, string> = {
  request_review: "start an independent review: another agent re-checks the delivered work, runs the checks, and reports pass or fail",
  complete: "accept the delivered work and mark the ticket done",
  rework: "send the work back for another round of changes",
  cancel: "cancel the ticket and drop the work",
  stop: "stop the ticket's running work for now",
  start: "start or continue executing the ticket's work",
  restore: "restore the cancelled ticket so that its work can continue",
};

export const REPLY_ACTION_QUESTIONS: Readonly<Record<TicketReplyActionId, YesNoQuestion>> = Object.fromEntries(
  TICKET_REPLY_ACTION_IDS.map((id) => [id, {
    type: "yes_no",
    prompt: `Is the reply waiting for the user to decide whether to ${ACTION_MEANINGS[id]}?`,
    yes: "the reply asks the user to choose, confirm or approve this action, and waits for the answer",
    no: "the reply does not ask the user about this action: it only reports, mentions it, or says it is already done",
  } satisfies YesNoQuestion]),
) as Record<TicketReplyActionId, YesNoQuestion>;

/** 送给 SmartModel 的 state：先遮住密钥，再取回复的最后 REPLY_TAIL_CHARS 个字。回复是空的时返回 null。 */
export function replyActionsState(reply: string): string | null {
  const clean = redactSecretText(reply).trim();
  if (!clean) return null;
  const truncated = clean.length > REPLY_TAIL_CHARS;
  const tail = truncated ? clean.slice(-REPLY_TAIL_CHARS) : clean;
  return [
    "An agent that works on a ticket wrote this reply to the user in the ticket's chat."
      + (truncated ? " Only the end of the reply is shown." : ""),
    "",
    "Reply:",
    tail,
  ].join("\n");
}

/** 问一次 SmartModel：这段回复在等用户决定要不要做哪几个动作。按 TICKET_REPLY_ACTION_IDS 的顺序。失败时抛错。 */
export async function judgeReplyActions(
  model: SmartModel, reply: string, opts: { signal?: AbortSignal } = {},
): Promise<{ actions: TicketReplyActionId[]; backend: string }> {
  const state = replyActionsState(reply);
  if (state === null) return { actions: [], backend: "none" };
  const decision = await model.decide(state, REPLY_ACTION_QUESTIONS, {
    purpose: REPLY_ACTIONS_PURPOSE,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const actions = TICKET_REPLY_ACTION_IDS.filter((id) => decision.answers[id].probability >= REPLY_ACTION_THRESHOLD);
  return { actions, backend: decision.backend };
}

export interface TicketReplyActionsJudge {
  /** 工单 agent 的一轮回答结束了：在后台判断，结果落库并通知客户端。不等结果。 */
  judge(turn: { turnId: string; itemId: number; text: string }): void;
  /** 等正在进行的判断结束（测试用）。 */
  idle(): Promise<void>;
  /** 停下：取消正在进行的判断，之后来的不再判断。关库之前调。 */
  stop(): Promise<void>;
}

export function createTicketReplyActionsJudge(input: {
  db: Db;
  // Lead 会话的 SmartModel。没有时不判断。
  smartModel: () => SmartModel | null;
  publish: (event: PublishGatewayEventInput) => unknown;
  log: (line: string) => void;
  deadlineMs?: number;
}): TicketReplyActionsJudge {
  const deadlineMs = input.deadlineMs ?? REPLY_ACTIONS_DEADLINE_MS;
  const inFlight = new Map<Promise<void>, AbortController>();
  let stopped = false;

  async function run(turn: { turnId: string; itemId: number; text: string }, model: SmartModel, controller: AbortController) {
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${deadlineMs} ms`)), deadlineMs);
    try {
      const { actions, backend } = await judgeReplyActions(model, turn.text, { signal: controller.signal });
      if (stopped) return;
      recordTicketReplyActions(input.db, { turnId: turn.turnId, itemId: turn.itemId, actions, backend });
      input.publish({
        type: "snapshot.required",
        requiredScope: "chat",
        itemId: turn.itemId,
        payload: { resource: TICKET_REPLY_ACTIONS_RESOURCE, ticketId: turn.itemId, turnId: turn.turnId },
      });
    } catch (error) {
      const reason = controller.signal.aborted && controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : error instanceof Error ? error.message : String(error);
      input.log(`[reply-actions] turn ${turn.turnId} of #${turn.itemId}: no reply buttons (${redactSecretText(reason).slice(0, 200)})`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    judge(turn) {
      if (stopped) return;
      const model = input.smartModel();
      if (!model) {
        input.log(`[reply-actions] turn ${turn.turnId} of #${turn.itemId}: no smart model; no reply buttons`);
        return;
      }
      const controller = new AbortController();
      const job = run(turn, model, controller).finally(() => { inFlight.delete(job); });
      inFlight.set(job, controller);
    },
    async idle() {
      while (inFlight.size) await Promise.allSettled([...inFlight.keys()]);
    },
    async stop() {
      stopped = true;
      for (const controller of inFlight.values()) controller.abort(new Error("daemon is stopping"));
      await Promise.allSettled([...inFlight.keys()]);
    },
  };
}
