// 设置页「常设指令」和会话里 StandingOrderChangeConfirm 卡的纯规则：级别、作者、提议的状态怎样说，时间怎样写。
// 契约在 packages/protocol/src/standing-orders-wire.ts（工单 10）。
import type {
  StandingOrderDto, StandingOrderExecutionDto, StandingOrderProposalDto,
} from '@pi-lead-child/protocol';

// 下面的 leadName 都是 Lead 的名字（useLeadName）。
export function standingOrdersDescription(leadName: string): string {
  return `${leadName} 按这些指令处理系统里的事：哪些只记下、哪些进摘要、哪些单独告诉它，`
    + '以及自动重试、合并和到时限升级。它改得更保守时直接生效，改得更放开时要你批准。';
}

export function standingOrdersRollbackNote(leadName: string): string {
  return `回滚会写一个新版本，内容和那一版一样。你回滚直接生效，${leadName} 会在下一轮知道。`;
}

// 系统写的文字（种子指令的标题和说明、档位判断的 findings）称呼 Lead 时写「Lead」。Lead 自己也读这些文字，后端不改。
// 显示时把独立的单词 Lead 换成 Lead 的名字。前后是英文字母、数字或下划线时不换：wakeLead、LeadX、Lead_x 都是标识符。
// 用户或 Lead 写的原因原样显示，不经过它。
const LEAD_WORD = /(^|[^A-Za-z0-9_])Lead(?![A-Za-z0-9_])/gu;

export function withLeadName(text: string, leadName: string): string {
  return text.replace(LEAD_WORD, (_match, before: string) => `${before}${leadName}`);
}

// 指令和版本的说明：作者是系统时是系统写的文字，换名字；Lead 或用户写的原样显示。
export function orderReasonText(order: Pick<StandingOrderDto, 'author' | 'reason'>, leadName: string): string {
  return order.author === 'system' ? withLeadName(order.reason, leadName) : order.reason;
}

type Level = NonNullable<StandingOrderDto['level']>;

export const LEVEL_LABELS: Record<Level, string> = {
  record: '只记录', digest: '进摘要', auto: '自动处理', tell: '单独告诉', interrupt: '打断',
};

export function authorLabel(author: StandingOrderDto['author'], leadName: string): string {
  return author === 'system' ? '系统' : author === 'lead' ? leadName : '你';
}

const OP_LABELS: Record<StandingOrderProposalDto['op'], string> = {
  create: '新增', update: '修改', disable: '停用', enable: '启用', rollback: '回滚',
};

export function levelLabel(level: string | null): string | null {
  return level && level in LEVEL_LABELS ? LEVEL_LABELS[level as Level] : null;
}

// 清单里一行的小字：编号、版本、谁写的、定什么级别或者是哪条规则。
export function orderSubtitle(order: StandingOrderDto, leadName: string): string {
  const what = order.level ? `定为「${LEVEL_LABELS[order.level]}」` : order.rule ? `规则 ${order.rule}` : null;
  return [`${order.id} · v${order.version}`, `${authorLabel(order.author, leadName)}写的`, what].filter(Boolean).join(' · ');
}

export function proposalTitle(proposal: StandingOrderProposalDto, leadName: string): string {
  const title = withLeadName(proposal.title, leadName);
  return proposal.op === 'rollback' && proposal.rollbackTo !== null
    ? `${leadName} 想把「${title}」回滚到 v${proposal.rollbackTo}`
    : `${leadName} 想${OP_LABELS[proposal.op]}「${title}」`;
}

// 已经处理过的提议怎样说。还在等你时返回 null。
export function proposalOutcome(proposal: StandingOrderProposalDto): { label: string; tone: 'success-dark' | 'secondary' } | null {
  switch (proposal.state) {
    case 'approved':
      return { label: `已批准，生效为 v${proposal.appliedVersion ?? '?'}`, tone: 'success-dark' };
    case 'rejected':
      return { label: '你没有批准，指令照旧', tone: 'secondary' };
    case 'expired':
      return {
        label: proposal.voidedReason === 'superseded' ? '指令后来又改过，这个提议作废了'
          : proposal.voidedReason === 'hard_rule' ? '碰到硬性安全规则，不能生效'
          : '过期了，没有生效',
        tone: 'secondary',
      };
    default:
      return null;
  }
}

// 只列更放开或者碰到规则的几项：这是要你看的理由。没有时列全部。findings 是系统写的，换名字。
export function proposalConcerns(proposal: StandingOrderProposalDto, leadName: string): string[] {
  const concerns = proposal.findings.filter((finding) => finding.tier !== 'conservative');
  return (concerns.length ? concerns : proposal.findings).map((finding) => withLeadName(finding.detail, leadName));
}

// 本地时间，月-日 时:分。读不出来时原样返回。
export function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 一条执行记录的小字：时间、事件类型、对象、作用（不是定级别时）。
export function executionSubtitle(execution: StandingOrderExecutionDto): string {
  const subject = execution.ticketId !== null ? `#${execution.ticketId}` : execution.subject;
  const effect = execution.effect === 'level' ? null : execution.effect;
  return [shortTime(execution.receivedAt), execution.kind, subject, `v${execution.version}`, effect].filter(Boolean).join(' · ');
}

// 指令内容的简短 JSON（条件、动作、上限），设置页上给想看细节的人。
export function compactJson(value: unknown): string {
  if (value === null || value === undefined) return '—';
  const text = JSON.stringify(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

// 请求失败时给人看的一句话：网关回的 message，或者一句通用的话。
export function standingOrderErrorText(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : '';
  return message || '请求没有完成，请再试一次。';
}

export function pendingProposalCount(proposals: readonly StandingOrderProposalDto[] | null | undefined): number {
  return (proposals ?? []).filter((proposal) => proposal.state === 'pending').length;
}
