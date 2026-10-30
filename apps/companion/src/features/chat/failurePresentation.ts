// 会话里的失败给人看的样子：一句白话，说清发生了什么、系统在做什么、你能做什么。
// 原始错误（provider 的 JSON、CLI 的报错、检查点的键值表、写给 Lead 的英文下一步）只放在失败卡展开以后的详情里。
// 以前这些原文直接画在会话里：每次心跳巡检一个 503 红框，「Run crashed」是一张键值表。
import {
  classifyLeadModelError, isLeadRestartInterruption, isSystemTurnOrigin, leadModelFailureReason, leadTurnFailureSentence,
  leadTurnWaitingSentence, SYSTEM_TURN_ORIGINS,
  type ConversationToolCall, type KernelCheckpoint, type LeadStatus,
} from '@pi-lead-child/protocol';

import { leadNameNow } from '../../state/leadName';
import type { MessageFailure } from '../../state/types';
import { itemOperationDoneWords } from './itemOperationWords';

export type FailureAction = 'resend' | 'retry' | 'remove' | 'refresh' | 'open-ticket';

/** 失败卡片上动作按钮的文字。会话和工单对话共用。 */
export const FAILURE_ACTION_LABELS: Record<FailureAction, string> = {
  resend: '重发',
  retry: '重试',
  remove: '删除',
  refresh: '刷新确认',
  'open-ticket': '打开工单',
};

export type FailurePresentation = {
  headline: string;
  actions: FailureAction[];
  // 失败卡展开以后的原文。没有原文时为 null，这一行不能展开。
  details: string | null;
  // 连着出现、可以合成一张卡片的同一种失败（只有 Lead 自己发起的回合才合并）。
  groupKey: string | null;
  tone: 'danger' | 'warning';
  // 画成哪个模式（2026-10-27 画布「没有回答」，主题 11.7、11.9）：
  //   absence：缺席占位，一行虚线框，「没有回答 · 你问的「…」」，点开看几行事实和原文；
  //   tail：回复说到一半被打断，接在已说出的文字后面的琥珀虚线胶囊；
  //   system：系统自己发起的那一轮没完成，居中的系统信息行，不给按钮。
  form: 'absence' | 'tail' | 'system';
  // 一行里的短话。absence 是 600 的短词（「没有回答」）；tail 和 system 是那一整句（「重启打断，会接着回复」）。
  label: string;
  // 你那句话（缺席占位引用它）。没有时为 null。
  quote: string | null;
  // 一行里跟在短词后面、要你先知道的话。有它时不引用你那句话：认证失败时直接「重发」也一样失败，要先说检查什么；
  // 在等自动重试时要说会自动再试。缺省为 null。
  summary?: string | null;
  // 点开以后的几行：做过、原因、接下来。原文另放在 details。
  facts: Array<{ label: string; value: string }>;
};

// 点开以后的几行事实。空的不写。
function facts(entries: Array<[string, string | null | undefined]>): Array<{ label: string; value: string }> {
  return entries.flatMap(([label, value]) => value ? [{ label, value }] : []);
}

// daemon 自己写的两句（packages/store 的 EMPTY_ASSISTANT_REPLY_ERROR，以及中断时的说明）。它们是用来认的标记，不随名字变。
// 给人看的文字称呼 Lead 用它的名字（设置 → 身份与风格）：这里的函数离组件远，用 leadNameNow()。
const EMPTY_REPLY = 'Lead 未生成回复，请重试。';
const ABORTED = 'Lead 回复被中断，请重试。';
const DAEMON_AUTH = 'Lead 模型连接认证失败，请重试。';

const SYSTEM_WORK: Record<string, string> = {
  [SYSTEM_TURN_ORIGINS.heartbeat]: '这次心跳巡检没有完成',
  [SYSTEM_TURN_ORIGINS.digest]: '这一批摘要没有处理完',
  [SYSTEM_TURN_ORIGINS.notification]: '这条通知还没播报出去',
  [SYSTEM_TURN_ORIGINS.blocker]: '这次没能处理新的 blocker',
  [SYSTEM_TURN_ORIGINS.precipitate]: '这次整理笔记没有完成',
};

type ModelFailure = 'network' | 'unavailable' | 'busy' | 'auth' | 'config' | 'context' | 'empty' | 'aborted' | 'restart' | 'unknown';

function modelFailure(raw: string): ModelFailure {
  const text = raw.trim();
  if (isLeadRestartInterruption(text)) return 'restart';
  if (text === EMPTY_REPLY) return 'empty';
  if (text === ABORTED) return 'aborted';
  if (text === DAEMON_AUTH) return 'auth';
  return classifyLeadModelError(text);
}

function reasonOf(kind: ModelFailure, name: string): string {
  if (kind === 'empty') return `${name} 这次没有给出回答`;
  if (kind === 'aborted') return `${name} 的回复被中断了`;
  if (kind === 'restart') return `${name} 的回复被重启打断了`;
  return leadModelFailureReason(kind, name);
}

function systemRecovery(lead: LeadStatus | undefined, clock: (value: string) => string): string {
  if (!lead || lead.state === 'online') return '模型现在已经恢复';
  if (lead.nextAttemptAt) return `系统会在 ${clock(lead.nextAttemptAt)} 自动再试`;
  return '系统会在下一次需要时再试';
}

// 这一轮的工具调用里改变了什么，用白话说（「提醒 #83 已创建」）。认得的是改日程和工单的那几个 Lead 工具；
// 别的完成了的调用只计数。render_ui 画的是给用户看的卡片，不算做了事。
type TurnTool = Pick<ConversationToolCall, 'name' | 'state' | 'args' | 'result'>;

function parsedPreview(preview: string | undefined): unknown {
  if (!preview) return null;
  try { return JSON.parse(preview); } catch { return preview; }
}

// 工具结果里给人看的文字。pi 的结果包在 { content: [{ type: 'text', text }] } 里；别的结构（details 等）不算。
function resultText(preview: string | undefined): string {
  const value = parsedPreview(preview);
  const content = value && typeof value === 'object' ? (value as { content?: unknown }).content : undefined;
  if (Array.isArray(content)) {
    return content.flatMap((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
      && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : [])).join('\n');
  }
  return typeof value === 'string' ? value : '';
}

// 这次调用的那一项。针对已有事项的工具（取消、改期……）看参数里的编号；新建的工具看结果文字里的第一个编号
// （「created reminder #83」）。不在原始 JSON 里随便找第一个 #：结果里可能还提到别的工单。
function toolItemId(tool: TurnTool): string | null {
  const args = parsedPreview(tool.args?.preview);
  if (args && typeof args === 'object') {
    for (const key of ['ticket_id', 'item_id', 'ticketId', 'itemId']) {
      const value = (args as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
      if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
    }
  }
  return /#(\d+)/.exec(resultText(tool.result?.preview))?.[1] ?? null;
}

function completedWork(tools: readonly TurnTool[]): string | null {
  const done = tools.filter((tool) => tool.state === 'completed' && tool.name !== 'render_ui');
  const named = done.flatMap((tool) => {
    const words = itemOperationDoneWords(tool.name, toolItemId(tool));
    return words ? [words] : [];
  });
  const others = done.length - named.length;
  if (!named.length) return others ? `${others} 个操作已完成` : null;
  return others ? `${[...new Set(named)].join('、')}，另有 ${others} 个操作已完成` : [...new Set(named)].join('、');
}

export function presentTurnFailure(input: {
  failure: MessageFailure;
  originKind: string | null | undefined;
  ticketId: number | null;
  // 这一轮用户说的话。没有时（旧入口的轮次）不给「重发」。
  userText: string | null;
  lead: LeadStatus | undefined;
  clock: (value: string) => string;
  // 这一轮的工具调用。调过工具的一轮可能已经建了提醒、工单：不给「重发」，免得做第二遍（2026-10-16 提醒 #83）。
  tools?: readonly TurnTool[];
  // 这一轮被重启打断以后，会话里已经有 Lead 接着回复的一轮。
  continued?: boolean;
}): FailurePresentation {
  const { failure, originKind, ticketId, userText, lead, clock } = input;
  const name = leadNameNow();
  const details = failure.message.trim() || null;
  const tools = (input.tools ?? []).filter((tool) => tool.name !== 'render_ui');
  const work = completedWork(tools);
  const canResend = Boolean(userText?.trim()) && tools.length === 0;
  const quote = userText?.trim() || null;
  if (failure.kind === 'timeout-unknown') {
    return {
      headline: '发送结果未知，消息已保留；刷新后确认是否已送达。', actions: ['refresh'], details: null, groupKey: null, tone: 'danger',
      form: 'absence', label: '不知道发出去没有', quote, facts: facts([['接下来', '消息已保留；刷新后确认是否已送达。']]),
    };
  }
  // 在等那一次自动重试：不是失败，不给「重发」（再发一次会多出一轮）。
  if (failure.kind === 'retry-pending') {
    const headline = leadTurnWaitingSentence(failure.message, failure.code === 'network' ? 'network' : 'model', name);
    return { headline, actions: [], details, groupKey: null, tone: 'warning', form: 'absence', label: '正在重试', quote, summary: headline, facts: [] };
  }
  if (failure.kind === 'rejected') {
    return {
      headline: '发送失败：这条消息没有发出去。你可以点「重试」，或者「删除」它。', actions: ['retry', 'remove'], details, groupKey: null, tone: 'danger',
      form: 'absence', label: '没有发出去', quote, facts: facts([['接下来', '你可以点「重试」，或者「删除」它。']]),
    };
  }
  const kind = modelFailure(failure.message);
  // 被重启打断不是失败：下一个 daemon 接着做（Lead 接着回复，或者再答一次）。不用红色，不给「重发」。
  // 排在工单对话的说法前面：在工单里发给 Lead 的话被打断，也是这一句。
  if (kind === 'restart') {
    const headline = isSystemTurnOrigin(originKind)
      ? leadTurnFailureSentence(failure.message, { system: true, name })!
      : `${work ? `${work}；` : ''}回复被重启打断，${input.continued ? `${name} 已接着回复。` : `${name} 会接着回复你。`}`;
    const system = isSystemTurnOrigin(originKind);
    return {
      headline, actions: [], details, groupKey: null, tone: 'warning',
      form: system ? 'system' : 'tail',
      label: system ? headline : `重启打断，${input.continued ? '已接着回复' : '会接着回复'}`,
      quote, facts: facts([['做过', work]]),
    };
  }
  if (ticketId !== null) {
    return {
      form: 'absence',
      label: tools.length ? '没有回答完' : '没有回答',
      quote,
      facts: facts([
        ['做过', work],
        ['原因', `工单 #${ticketId} 的 agent 没能回答${tools.length ? '完' : ''}这条消息${tools.length ? '' : '，工单本身没有变化'}`],
        ['接下来', tools.length ? '它已经做过的事不会重做，你可以在工单里接着说。' : canResend ? null : '你可以在工单里再问一次。'],
      ]),
      headline: tools.length
        ? `工单 #${ticketId} 的 agent 没能回答完这条消息；它已经做过的事不会重做，你可以在工单里接着说。`
        : `工单 #${ticketId} 的 agent 没能回答这条消息，工单本身没有变化；`
          + (canResend ? '你可以点「重发」再问一次。' : '你可以在工单里再问一次。'),
      actions: canResend ? ['resend'] : [],
      details,
      groupKey: null,
      tone: 'danger',
    };
  }
  const reason = reasonOf(kind, name);
  if (isSystemTurnOrigin(originKind)) {
    const work = SYSTEM_WORK[originKind!] ?? `${name} 这次主动处理没有完成`;
    const headline = kind === 'auth' || kind === 'config'
      ? `${reason}，${work}；系统没法自己恢复，请检查 ${name} 的模型${kind === 'auth' ? '账号' : '配置'}。`
      : kind === 'network'
        ? `${reason}，${work}；网络恢复后系统会继续，你不需要操作。`
        : `${reason}，${work}；${systemRecovery(lead, clock)}，你不需要操作。`;
    return {
      headline, actions: [], details, groupKey: turnFailureGroupKey(failure, originKind), tone: 'warning',
      form: 'system', label: work.replace(/^这(次|一批|条)/u, ''), quote: null,
      // 接下来写系统自己会怎样，不写「你不需要操作」：系统信息行本来就不给按钮。
      facts: facts([['原因', reason], ['接下来', kind === 'auth' || kind === 'config'
        ? `系统没法自己恢复，请检查 ${name} 的模型${kind === 'auth' ? '账号' : '配置'}`
        : kind === 'network' ? '网络恢复后系统会继续' : systemRecovery(lead, clock)]]),
    };
  }
  // 这一轮已经做了事：先说做了什么，再说回复没完成。不给「重发」，让用户直接告诉 Lead 接着做。
  if (tools.length) {
    const cause = kind === 'unknown' || kind === 'empty' || kind === 'aborted' ? '' : `${reason}，`;
    // 认证、配置的失败再试也一样：先说要检查什么（发布评审 3688968）。
    const next = kind === 'auth' || kind === 'config'
      ? `请先检查 ${name} 的模型${kind === 'auth' ? '账号' : '配置'}，再告诉 ${name} 接着做；做过的事不会重做。`
      : `做过的事不会重做；要继续的话，直接告诉 ${name}。`;
    return {
      headline: `${work ? `${work}；` : ''}${cause}回复没有完成。${next}`,
      actions: [],
      details,
      groupKey: null,
      tone: 'danger',
      form: 'absence',
      label: '没有回答完',
      quote,
      facts: facts([['做过', work], ['原因', cause ? reason : null], ['接下来', next]]),
    };
  }
  const resend = canResend ? '点「重发」' : '再发一次';
  const headline = kind === 'network' || kind === 'unavailable' || kind === 'busy'
    ? `${reason}，这条消息没有得到回答；系统不会自动重发，你可以${resend}。`
    : kind === 'auth' || kind === 'config'
      ? `${reason}，这条消息没有得到回答；请先检查 ${name} 的模型${kind === 'auth' ? '账号' : '配置'}，再${resend}。`
      : kind === 'unknown'
        ? `${name} 这次没有完成回复；你可以${resend}再试一次。`
        : `${reason}；你可以${resend}再问一次。`;
  const next = kind === 'auth' || kind === 'config'
    ? `请先检查 ${name} 的模型${kind === 'auth' ? '账号' : '配置'}，再${resend}。`
    : kind === 'network' || kind === 'unavailable' || kind === 'busy' ? `系统不会自动重发，你可以${resend}。` : canResend ? null : `你可以${resend}。`;
  return {
    headline, actions: canResend ? ['resend'] : [], details, groupKey: null, tone: 'danger',
    form: 'absence', label: '没有回答', quote,
    summary: kind === 'auth' || kind === 'config' ? `请先检查 ${name} 的模型${kind === 'auth' ? '账号' : '配置'}，再${canResend ? '重发' : '发一次'}` : null,
    facts: facts([['原因', kind === 'unknown' ? `${name} 这次没有完成回复` : reason], ['接下来', next]]),
  };
}

// ── Run 失败的检查点 ──────────────────────────────────────────────────────────

const CATEGORY_PHRASE: Record<string, string> = {
  model_capacity: '遇到模型满载',
  provider_unavailable: '连不上模型服务',
  run_interrupted: '运行被中断',
  authentication: '认证失败',
  account_quota: '账号余额不足',
  // 用量额度用完、在等重置（usage_limited）：不用充值，等重置或者换模型。
  usage_limit: '用量额度用完，在等重置',
  model_unsupported: '不支持这个模型',
  runtime_unavailable: '没能启动',
  runtime_configuration: '配置有误',
  host_defect: '遇到宿主代码出错',
};

export type RunFailureCheckpointPresentation = {
  label: string;
  tone: 'danger' | 'warning';
  headline: string;
  needsUser: boolean;
  // 展开以后的详情：原来的标题、摘要、键值表和写给 Lead 的下一步。
  details: string;
};

function fact(checkpoint: KernelCheckpoint, label: string): string | null {
  return checkpoint.keyFacts.find((item) => item.label === label)?.value ?? null;
}

/**
 * 系统记下的一次 Run 失败（检查点带 Failure category 这一项）。别的检查点返回 null，照常显示。
 * - lead：现在的 Lead 健康状态。失败还没过去、Lead 的模型又连不上时，不能说"Lead 会判断"。
 * - settled：这次失败已经过去了（工单后来结束了，或者不再阻塞）。这时只说当时发生了什么，
 *   不拿现在的 Lead 健康状态来说话；工单现在的状态由卡片上的「现在：…」标签说。
 * - leadHandling：工单的 TicketSummary 说 Lead 正在处理（attention.leadHandling，没有升级给用户）。
 *   2026-10-15 用户决定：异常先交给 Lead，除非需要用户介入，UI 只给弱反馈。这时不说「需要你处理」。
 * - escalated：工单有要用户行动的 blocker（attention.blockerCount）。Lead 没能处理，这时不说「Lead 处理中」。
 */
export function presentRunFailureCheckpoint(
  checkpoint: KernelCheckpoint,
  context: { lead?: LeadStatus; settled?: boolean; leadHandling?: boolean; escalated?: boolean } = {},
): RunFailureCheckpointPresentation | null {
  const { lead, settled = false, leadHandling = false, escalated = false } = context;
  const name = leadNameNow();
  const category = fact(checkpoint, 'Failure category');
  if (category === null || checkpoint.source !== 'system_derived') return null;
  const agent = fact(checkpoint, 'Agent') ?? 'agent';
  const scope = fact(checkpoint, 'Failure scope');
  const needs = fact(checkpoint, 'Needs');
  const next = checkpoint.nextStep ?? '';
  const phrase = CATEGORY_PHRASE[category] ?? '运行出错';
  const subject = `工单 #${checkpoint.ticketId} 的 ${agent} ${phrase}`;
  const exhausted = /exhausted|已经自动重试|停止自动重试|重试已耗尽|已用尽/i.test(next);
  const details = [
    checkpoint.title,
    checkpoint.summary,
    ...checkpoint.keyFacts.map((item) => `${item.label}: ${item.value}`),
    checkpoint.nextStep ? `Next: ${checkpoint.nextStep}` : null,
  ].filter(Boolean).join('\n');
  if (settled) return { label: '运行失败', tone: 'warning', headline: `${subject}。`, needsUser: false, details };
  if (leadHandling) {
    return { label: `${name} 处理中`, tone: 'warning', headline: `${subject}，${name} 正在处理；需要你时它会告诉你。`, needsUser: false, details };
  }
  let label = '需要你处理';
  let tone: RunFailureCheckpointPresentation['tone'] = 'danger';
  let needsUser = true;
  let rest: string;
  if (checkpoint.kind === 'progress') {
    label = '自动重试中';
    tone = 'warning';
    needsUser = false;
    rest = '系统会自动重试；你不需要操作。';
  } else if (needs === 'login') {
    rest = `系统暂停了派发；需要你重新登录 ${agent}。`;
  } else if (needs === 'refill') {
    rest = `系统暂停了派发；需要给 ${agent} 的账号充值。`;
  } else if (needs === 'config') {
    rest = `系统暂停了派发；需要修正 ${agent} 的配置。`;
  } else if (needs === 'code_fix') {
    rest = '系统停止了这张工单；需要修复宿主代码。';
  } else if (exhausted) {
    rest = '自动重试已经用完；需要你决定下一步。';
  } else if ((scope === 'task' || scope === 'unknown' || scope === null) && escalated) {
    rest = `${name} 没能处理它；需要你看一下。`;
  } else if ((scope === 'task' || scope === 'unknown' || scope === null) && lead?.state === 'degraded') {
    label = `等 ${name} 恢复`;
    tone = 'warning';
    rest = `${name} 现在连不上模型，恢复后会判断能不能安全重试；着急的话可以打开工单自己处理。`;
  } else if (scope === 'task' || scope === 'unknown' || scope === null) {
    label = `${name} 处理中`;
    tone = 'warning';
    needsUser = false;
    rest = `${name} 会判断能不能安全重试；需要你决定时它会告诉你。`;
  } else {
    rest = '系统不会自动重试这次运行；你可以稍后在工单里重试。';
  }
  return { label, tone, headline: `${subject}，${rest}`, needsUser, details };
}

/** 连着出现时能合成一张卡片的失败：Lead 自己发起的回合，同一个来源、同一种原因。其他失败返回 null。 */
// 被重启打断的不合并：它不是一次失败，不进失败汇总。
export function turnFailureGroupKey(failure: MessageFailure | null, originKind: string | null | undefined): string | null {
  if (failure?.kind !== 'turn-error' || !isSystemTurnOrigin(originKind)) return null;
  const kind = modelFailure(failure.message);
  return kind === 'restart' ? null : `${originKind}|${kind}`;
}

// ── 系统写的检查点 ────────────────────────────────────────────────────────────
//
// 2026-10-27 用户：「系统更新」那张大卡（整块灰底、英文标题、写给 Lead 的下一步）按模式「系统信息行」重画：
// 居中一行中文；要你处理时带一个按钮；原文点开再看。
// 引擎和 daemon 写的这几种检查点标题是代码里的常量（写给 Lead 看的英文），按原文对照成给人看的中文，不按意思猜。
const SYSTEM_CHECKPOINT_WORDS: Record<string, (ticket: number) => string> = {
  'Run reclaimed after daemon restart': (ticket) => `工单 #${ticket} 的 Run 在 daemon 重启时被收回`,
  'Run recovered after daemon restart': (ticket) => `工单 #${ticket} 的 Run 被收回以后，系统接着派发了`,
  'Run recovered after dispatch interruption': (ticket) => `工单 #${ticket} 的 Run 被收回以后，系统接着派发了`,
  'Run dispatch failed': (ticket) => `工单 #${ticket} 的 Run 没能启动`,
  'Run stopped after repeated daemon restarts': (ticket) => `工单 #${ticket} 的 Run 反复被 daemon 重启打断，系统停掉了它`,
};

export type SystemCheckpointPresentation = {
  // 一行里的话。
  text: string;
  // 要你处理：图标红色，行尾「打开工单」。
  needsUser: boolean;
  // 这件事已经好了（系统接着派发了）：图标用进度，不用警告。
  ok: boolean;
  // 点开以后的原文：标题、摘要、键值、写给 Lead 的下一步。
  details: string;
};

/**
 * 系统写的检查点（source 是 system_derived，没有挂着审批或决策请求）在会话里的一行。别的检查点返回 null，照常显示。
 * context 和 presentRunFailureCheckpoint 一样：settled 是这件事已经过去了，leadHandling 是 Lead 正在处理，
 * escalated 是工单有要你行动的 blocker。nowLabel 是卡片旁边的「现在：…」。
 */
export function presentSystemCheckpoint(
  checkpoint: KernelCheckpoint,
  context: { lead?: LeadStatus; settled?: boolean; leadHandling?: boolean; escalated?: boolean; nowLabel?: string | null } = {},
): SystemCheckpointPresentation | null {
  if (checkpoint.source !== 'system_derived' || checkpoint.actionRef) return null;
  const name = leadNameNow();
  const details = [
    checkpoint.title,
    checkpoint.summary,
    ...checkpoint.keyFacts.map((item) => `${item.label}: ${item.value}`),
    checkpoint.nextStep ? `Next: ${checkpoint.nextStep}` : null,
  ].filter(Boolean).join('\n');
  // 带失败类别的 Run 失败：说法已经在 presentRunFailureCheckpoint 里（哪个 agent、为什么、系统在做什么）。
  const failure = presentRunFailureCheckpoint(checkpoint, context);
  if (failure) {
    const text = failure.headline.replace(/[。；]$/u, '');
    return { text: context.settled && context.nowLabel ? `${text} · ${context.nowLabel}` : text, needsUser: failure.needsUser, ok: false, details };
  }
  const words = SYSTEM_CHECKPOINT_WORDS[checkpoint.title]?.(checkpoint.ticketId) ?? `工单 #${checkpoint.ticketId}：${checkpoint.title}`;
  if (checkpoint.kind !== 'blocked') return { text: words, needsUser: false, ok: true, details };
  // 卡住了：工单后来变了就说现在怎样；有要你行动的 blocker 就要你处理；Lead 在处理就说它在处理；
  // 都不是时，这件事先交给 Lead（2026-10-15 用户决定：异常先交给 Lead，除非需要用户介入）。
  if (context.settled) return { text: context.nowLabel ? `${words} · ${context.nowLabel}` : words, needsUser: false, ok: false, details };
  if (context.escalated) return { text: `${words} · ${name} 没能处理，需要你看一下`, needsUser: true, ok: false, details };
  if (context.leadHandling) return { text: `${words} · ${name} 在处理`, needsUser: false, ok: false, details };
  return { text: `${words} · ${name} 会判断要不要重新派发`, needsUser: false, ok: false, details };
}
