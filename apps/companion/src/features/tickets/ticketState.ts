// 工单详情卡片的"现在是什么状态、你能做什么"（工单 #66 复核 F8/F10/F11/F15）。
//
// 以前同一个状态在卡片上有五种说法：徽章说"返工已用尽且成果未登记"，下一步卡片说"独立核查未通过"，
// 托管卡片说"可自动交付"，红色卡片说"卡住了"，底部栏说"验收决策"。它们读的是同一个
// TicketSummary，却各自做了有损的映射。现在只有这一个函数做映射：徽章、状态区块、选项区块、
// 托管说明和底部栏都读它的输出，不再各自推导（AGENTS.md：每个界面从同一个 TicketSummary
// 推导当前状态）。
import type { KernelOutcomeSnapshotResource } from '@pi-lead-child/protocol';

import {
  formatCompactElapsed,
  supersededReviewText,
  ticketNextActionPresentation,
  type Ticket,
  type TicketActionId,
  type TicketActionPresentation,
} from '@/features/workspace/model';

import { leadNameNow } from '@/state/leadName';

import { elapsedText, type TicketRunProgress } from './ticketChatStatus';

export type TicketStateTone = 'info' | 'attention' | 'danger' | 'success' | 'neutral';

export type TicketOptionId = TicketActionId | 'request_review';

export type TicketOptionPresentation = {
  id: TicketOptionId;
  label: string;
  /** 点下去会发生什么。null 表示动作本身已经说清楚了。 */
  consequence: string | null;
  tone: 'primary' | 'neutral' | 'danger';
  recommended: boolean;
};

export type TicketStatePresentation = {
  /** 元信息行里的短标签。 */
  chip: string;
  tone: TicketStateTone;
  headline: string;
  why: string | null;
  facts: { label: string; value: string }[];
  options: TicketOptionPresentation[];
  /** 自动化接下来会做什么；null 表示这个状态下不涉及自动化。托管区块读这一句。 */
  automation: string | null;
};

export type TicketStateInput = {
  ticket: Ticket;
  /** 当前合法、并且界面已经按执行状态过滤过的动作。 */
  actions: TicketActionPresentation[];
  outcome?: KernelOutcomeSnapshotResource | null;
  timing?: { statusDurationMs?: number | null } | null;
  /** 阻塞的工单：最新那条阻塞记录说明了原因。 */
  blocker?: { title: string; summary: string } | null;
  /** 用户已经处理了介入请求，工单还停在 blocked，等 child 或 Lead 重新上报。 */
  awaitingAfterIntervention?: boolean;
  /** 正在跑的那次 Run（ticketChatStatus）。核查 Run 准备太久时，状态卡要说出来，不能写「正在进行」。 */
  liveRun?: TicketRunProgress | null;
  /** Lead 的名字（useLeadName）。不给时读最近一次取到的名字（leadNameNow）。 */
  leadName?: string;
};

type ReviewState = NonNullable<Ticket['reviewState']>;

const VERDICT_TEXT = { pass: 'PASS', fail: 'FAIL' } as const;

// 核查自动化只在出结论的那一笔事务里跑一次（delegated-review.ts 的 applyReviewAutomation）：
// FAIL 时要么打回 active 并派返工，要么停手；PASS 时要么直接结单，要么停手。所以工单还停在
// review、又已经有了结论，就说明自动化已经停手了（#66 的 FAIL 发生在授权之前）。这时卡片不能
// 再说"Lead 会返工 / 会交付"，只能照实说没有自动动作，并给用户一个推荐。
const NO_AUTOMATION = '当前没有自动动作在进行。';

// 核查走到哪一步。排队、挂起、在跑是三种不同的状态，不能都写成"正在进行"。
const PROGRESS_FACT = { queued: '排队中', suspended: '已暂停', running: '进行中' } as const;

function budgetUsed(review: ReviewState): { used: number; max: number } | null {
  if (review.reworkCyclesUsed === undefined || review.maxReworkCycles === undefined || review.maxReworkCycles === null) {
    return null;
  }
  return { used: review.reworkCyclesUsed, max: review.maxReworkCycles };
}

function deliveryRunOf(review: ReviewState, outcome: KernelOutcomeSnapshotResource | null | undefined): number | null {
  return review.deliveryRunId ?? outcome?.latest?.executorAttemptId ?? null;
}

function reviewFacts(
  review: ReviewState,
  input: TicketStateInput,
  options: { reviewing: boolean },
): { label: string; value: string }[] {
  const delivery = deliveryRunOf(review, input.outcome);
  const snapshot = input.outcome?.latest && input.outcome.latest.executorAttemptId === delivery ? input.outcome.latest : null;
  const budget = budgetUsed(review);
  const superseded = supersededReviewText(review);
  const stayed = formatCompactElapsed(input.timing?.statusDurationMs);
  return [
    ...(delivery === null ? [] : [{
      label: '最新交付',
      value: snapshot ? `Run #${delivery} · 成果快照 #${snapshot.id}` : `Run #${delivery}`,
    }]),
    {
      label: '独立核查',
      value: review.reviewerAttemptId !== null
        ? `Run #${review.reviewerAttemptId} · ${review.verdict ? VERDICT_TEXT[review.verdict] : '结论未知'}`
        : review.reviewProgress
          ? PROGRESS_FACT[review.reviewProgress]
          : options.reviewing
            ? '即将开始'
            : delivery === null ? '未核查' : `Run #${delivery} 未核查`,
    },
    ...(superseded ? [{ label: '上次核查', value: superseded }] : []),
    ...(budget ? [{ label: '返工额度', value: `${budget.used}/${budget.max} 已用` }] : []),
    ...(stayed ? [{ label: '停留', value: `${stayed} 未变化` }] : []),
  ];
}

// 用户发起的返工不占 Lead 的返工额度（2026-10-13 用户确认）；有额度时把这一点说出来。
function reworkConsequence(review: ReviewState, input: TicketStateInput): string {
  const delivery = deliveryRunOf(review, input.outcome);
  const base = delivery === null ? '重新执行这张工单' : `从 Run #${delivery} 的交付继续返工`;
  const leadName = input.leadName ?? leadNameNow();
  return budgetUsed(review) ? `${base}；这是你发起的返工，不占用 ${leadName} 的返工额度。` : `${base}。`;
}

/** 把合法动作翻成带后果的选项。只翻 review 阶段用得到的三个；其余动作保持原样。 */
function reviewOptions(
  input: TicketStateInput,
  review: ReviewState,
  copy: {
    complete?: { label: string; consequence: string | null; tone: TicketOptionPresentation['tone'] } | null;
    rework?: { label: string } | null;
    recommended?: TicketOptionId | null;
    requestReview?: boolean;
    requestReviewLabel?: string;
    requestReviewConsequence?: string;
  },
): TicketOptionPresentation[] {
  const delivery = deliveryRunOf(review, input.outcome);
  const options: TicketOptionPresentation[] = [];
  if (copy.requestReview) {
    options.push({
      id: 'request_review',
      label: copy.requestReviewLabel ?? '派发独立核查',
      consequence: copy.requestReviewConsequence
        ?? (delivery === null ? '派一个独立 reviewer 核查最新的交付。' : `派一个独立 reviewer 核查 Run #${delivery} 的成果。`),
      tone: 'primary',
      recommended: copy.recommended === 'request_review',
    });
  }
  for (const action of input.actions) {
    if (action.id === 'complete') {
      if (copy.complete === null) continue;
      const complete = copy.complete ?? { label: '验收通过', consequence: null, tone: 'primary' as const };
      options.push({ id: 'complete', ...complete, recommended: copy.recommended === 'complete' });
    } else if (action.id === 'rework') {
      if (copy.rework === null) continue;
      options.push({
        id: 'rework',
        label: copy.rework?.label ?? '手动返工',
        consequence: reworkConsequence(review, input),
        tone: copy.recommended === 'rework' ? 'primary' : 'neutral',
        recommended: copy.recommended === 'rework',
      });
    } else if (action.id === 'cancel') {
      options.push({ id: 'cancel', label: '取消工单', consequence: '放弃这次交付，工单结束。', tone: 'danger', recommended: false });
    } else {
      options.push({ id: action.id, label: action.label, consequence: null, tone: action.tone, recommended: false });
    }
  }
  return options;
}

// 挂起的核查重新排（user-actions.ts 的 requestReview）。服务端只在有能用的核查员时才给这个按钮。
const REPICK_REVIEW_LABEL = '重新排核查';
const REPICK_REVIEW_CONSEQUENCE = '原来的核查员能用就用它，不能用就换一个能用的。';

function reviewPresentation(input: TicketStateInput, review: ReviewState): TicketStatePresentation {
  const { ticket } = input;
  const delivery = deliveryRunOf(review, input.outcome);
  const deliveryName = delivery === null ? '最新的交付' : `Run #${delivery}`;
  const budget = budgetUsed(review);
  const exhausted = budget !== null && budget.used >= budget.max;

  // 要求独立核查、却没有核查会来：工单卡住了（#66）。由用户验收的工单能派核查，只是多一个选项。
  // 挂起的核查也能重新派（换一个能用的核查员），但它派过了，走下面「核查已暂停」的分支（2026-10-21）。
  if (review.canRequestReview && review.state === 'independent_review' && (review.reviewProgress ?? null) === null) {
    return {
      chip: '核查未派发',
      tone: 'attention',
      headline: `${deliveryName} 已交付，但还没有被独立核查。`,
      why: `系统不会自动派发核查，需要你决定下一步。${exhausted ? '返工额度已用完。' : ''}`,
      facts: reviewFacts(review, input, { reviewing: false }),
      options: reviewOptions(input, review, {
        requestReview: true,
        recommended: 'request_review',
        complete: { label: '仍要验收通过', consequence: '没有核查结论就结单。', tone: 'danger' },
      }),
      automation: NO_AUTOMATION,
    };
  }

  switch (review.state) {
    case 'rework_exhausted':
      return {
        chip: '卡住',
        tone: 'danger',
        headline: review.outcomeRecoveryFailed
          ? `最后一次交付（${deliveryName}）没有登记成果，自动化已停止。`
          : '返工额度已用完，自动化已停止。',
        why: review.reason,
        facts: reviewFacts(review, input, { reviewing: false }),
        options: reviewOptions(input, review, {
          complete: {
            label: '仍要验收通过',
            consequence: review.outcomeRecoveryFailed
              ? '最后一次交付没有成果可核查，现在验收等于在没有证据的情况下结单。'
              : '当前没有通过的核查结论，现在验收等于在没有通过证据的情况下结单。',
            tone: 'danger',
          },
          recommended: 'rework',
        }),
        automation: NO_AUTOMATION,
      };
    case 'evidence_conflict':
      return {
        chip: '证据冲突',
        tone: 'danger',
        headline: '核查证据互相矛盾，需要你判断。',
        why: review.reason,
        facts: reviewFacts(review, input, { reviewing: false }),
        options: reviewOptions(input, review, {
          complete: { label: '仍要验收通过', consequence: '验收前请先确认以哪一份证据为准。', tone: 'danger' },
          recommended: 'rework',
        }),
        automation: NO_AUTOMATION,
      };
    case 'review_failed':
      return {
        chip: '核查不通过',
        tone: 'attention',
        headline: '独立核查不通过。',
        why: review.reason,
        facts: reviewFacts(review, input, { reviewing: false }),
        // 核查不通过时不提供"验收通过"：与以前的规则相同（TicketThread 一直把它去掉）。
        options: reviewOptions(input, review, {
          complete: null,
          rework: { label: '打回返工' },
          recommended: 'rework',
        }),
        automation: NO_AUTOMATION,
      };
    case 'review_passed':
      return {
        chip: '核查通过',
        tone: 'success',
        headline: '核查通过，等你验收。',
        why: review.reason,
        facts: reviewFacts(review, input, { reviewing: false }),
        options: reviewOptions(input, review, { recommended: 'complete' }),
        automation: NO_AUTOMATION,
      };
    case 'waiting_user': {
      // 你派的核查被挂起时，按钮是重新排它，不是再派一个（2026-10-21 审查 M4）。
      const paused = review.reviewProgress === 'suspended';
      return {
        chip: '待验收',
        tone: 'attention',
        headline: '执行已结束，等你验收。',
        why: review.reason ?? '这张工单没有独立核查，由你判断是否完成。',
        facts: reviewFacts(review, input, { reviewing: false }),
        options: reviewOptions(input, review, {
          recommended: 'complete',
          rework: { label: '打回返工' },
          requestReview: review.canRequestReview === true,
          ...(paused ? { requestReviewLabel: REPICK_REVIEW_LABEL } : {}),
          requestReviewConsequence: paused
            ? REPICK_REVIEW_CONSEQUENCE
            : `派一个独立 reviewer 核查 ${deliveryName} 的成果；结论出来前你仍然可以直接验收。`,
        }),
        automation: NO_AUTOMATION,
      };
    }
    default: {
      // independent_review：核查在跑、已排队、排队但被挂起，或交付的 child 还在收尾。
      const progress = review.reviewProgress ?? null;
      const stalled = input.liveRun?.purpose === 'review' && input.liveRun.stalled ? input.liveRun : null;
      if (stalled) {
        // #66：核查 Run #73 停在 starting，状态卡却写着「核查中」。准备超过一分钟就照实说。
        return {
          chip: '核查没有开始',
          tone: 'attention',
          headline: `核查 Run #${stalled.runId} 准备了 ${elapsedText(stalled.elapsedMs).replace(/^已 /, '')}，还没有开始。`,
          why: '通常 10 秒内开始，这次可能卡住了。',
          facts: reviewFacts(review, input, { reviewing: true }),
          options: reviewOptions(input, review, {
            complete: { label: '跳过核查直接验收', consequence: '独立核查尚未给出结论，现在验收等于跳过核查。', tone: 'danger' },
          }),
          automation: null,
        };
      }
      // 没有核查在路上，也派不了：这张工单还有 Run 在进行（工单对话也算）。服务端在有 Run 改动工作区时
      // 不派核查（review-authority 的 unreviewedDelivery），所以 canRequestReview 是 false。以前这里
      // 照样写「核查中 · 执行已结束，独立核查即将开始」，可并没有核查要开始（复核 P0-5：#66 在对话
      // Run #72 收尾时打开，先显示「即将开始」，Run 结束后才变成「核查未派发」）。
      const runInFlight = ticket.runtimeState === 'running' || ticket.runtimeState === 'starting'
        || ticket.runtimeState === 'stale';
      if (progress === null && runInFlight) {
        const live = input.liveRun && input.liveRun.purpose !== 'review' ? input.liveRun : null;
        return {
          chip: '等 Run 结束',
          tone: 'info',
          headline: live?.purpose === 'conversation'
            ? `工单对话 Run #${live.runId} 还在回答，答完才能派发独立核查。`
            : live
              ? `Run #${live.runId} 还在进行，结束后才能派发独立核查。`
              : '这张工单还有一个 Run 在进行，结束后才能派发独立核查。',
          why: '有 Run 在进行时不派核查：核查要看一个不再变化的工作区。',
          facts: reviewFacts(review, input, { reviewing: false }),
          options: reviewOptions(input, review, {
            complete: { label: '跳过核查直接验收', consequence: '独立核查尚未给出结论，现在验收等于跳过核查。', tone: 'danger' },
          }),
          automation: 'Run 结束后状态会自动更新。',
        };
      }
      return {
        chip: progress === 'suspended' ? '核查已暂停' : progress === 'queued' ? '核查排队中' : '核查中',
        tone: progress === 'suspended' ? 'attention' : 'info',
        headline: progress === 'running'
          ? '独立核查正在进行。'
          : progress === 'queued'
            ? '独立核查已排队，等待开始。'
            : progress === 'suspended'
              ? '独立核查已排队，但暂时不能开始。'
              : '执行已结束，独立核查即将开始。',
        why: progress === 'suspended' ? review.reason : null,
        facts: reviewFacts(review, input, { reviewing: true }),
        options: reviewOptions(input, review, {
          complete: { label: '跳过核查直接验收', consequence: '独立核查尚未给出结论，现在验收等于跳过核查。', tone: 'danger' },
          requestReview: progress === 'suspended' && review.canRequestReview === true,
          requestReviewLabel: REPICK_REVIEW_LABEL,
          requestReviewConsequence: REPICK_REVIEW_CONSEQUENCE,
        }),
        automation: '核查结束后状态会自动更新。',
      };
    }
  }
}

export function ticketStatePresentation(input: TicketStateInput): TicketStatePresentation {
  const presentation = stagePresentation(input);
  // 工单上有等你回答的决定（Lead 的决定卡，或者 agent 的决策请求）：轮到你做的就是回答它（2026-10-16）。
  // 不再按阶段推荐动作（以前收件箱和这里写「派发独立核查」，决定卡问的却是「并入 #72 / 再返工 / 取消」）；
  // 阶段动作留在「其他选择」里。详情在这张卡上直接放这条决定和它的选项。
  if ((input.ticket.pendingDecisionCount ?? 0) > 0) {
    return {
      ...presentation,
      chip: input.ticket.statusLabel,
      tone: 'attention',
      headline: '等你决定',
      why: `先回答这张工单上的决定。你选完以后，${input.leadName ?? leadNameNow()} 或 agent 会接着做。`,
      options: presentation.options.map((option) => ({ ...option, recommended: false })),
      automation: null,
    };
  }
  return presentation;
}

function stagePresentation(input: TicketStateInput): TicketStatePresentation {
  const { ticket } = input;
  if (ticket.status === 'review' && ticket.reviewState) return reviewPresentation(input, ticket.reviewState);
  const execution = ticket.executionState
    && (ticket.executionState.state !== 'running' || ticket.executionState.kind === 'recovery')
    ? ticket.executionState
    : null;
  const executionStopped = execution?.state === 'failed' || execution?.state === 'blocked';
  // 优先级与以前分散在卡片上的几块相同：已处理介入 > 执行状态 > 阻塞记录 > 通用下一步。
  const next = input.awaitingAfterIntervention && ticket.status === 'blocked'
    ? {
      label: '授权已记录，等待执行状态确认',
      body: `当前工单仍处于阻塞；等待 child 或 ${input.leadName ?? leadNameNow()} 重新上报执行结果。`,
      tone: 'attention' as const,
    }
    : execution
      ? { label: execution.label, body: execution.reason ?? '', tone: executionStopped ? 'danger' as const : 'info' as const }
      : input.blocker && ticket.status === 'blocked'
        ? { label: input.blocker.title, body: input.blocker.summary, tone: 'danger' as const }
        : ticketNextActionPresentation(ticket);
  const options = input.actions.map((action): TicketOptionPresentation => ({
    id: action.id,
    label: action.id === 'cancel' ? '取消工单' : action.label,
    consequence: null,
    tone: action.tone,
    recommended: false,
  }));
  const recommended = options.find((option) => option.tone === 'primary');
  if (recommended) recommended.recommended = true;
  return {
    chip: execution?.kind === 'recovery' && !executionStopped ? execution.label : ticket.statusLabel,
    tone: next?.tone ?? (ticket.status === 'done' || ticket.status === 'acked' ? 'success' : 'neutral'),
    headline: next?.label ?? ticket.statusLabel,
    why: next?.body || null,
    facts: [],
    options,
    automation: next?.tone === 'info' ? next.body : null,
  };
}
