import { Absence, AbsenceTail, NoticeRow, Row, SystemLine, Text } from '@pi-lead-child/components';
import type { ReactNode } from 'react';


import { FAILURE_ACTION_LABELS, type FailurePresentation } from './failurePresentation';
import { leadModelLabel } from './leadModelGroups';

// 会话里的一张失败卡片：一句白话（见 ./failurePresentation），能做的事给按钮，原文在展开以后。
// 2026-10-16 用户要求：卡片太大。没有回答的那一轮是一行可以展开的条目。
// 2026-10-27 按画布「没有回答」改成三个模式（主题 11.7、11.9），由 presentation.form 决定：
//   absence：缺席占位。一行虚线框，「没有回答 · 你问的「…」」，右边「重发」；点开在浮层里看做过、原因、接下来和原文。
//   tail：说到一半被打断。已说出的文字留着，后面接一个琥珀虚线胶囊，写原因。
//   system：系统自己发起的那一轮没完成。居中一行，连续几次时前面三个小圆点，不给按钮。
// 没有 presentation 的调用（blocker 提醒、Run 失败的检查点）照旧是一行可以展开的提示（NoticeRow）。
export function FailureCard({
  headline,
  tone,
  details,
  meta,
  actions = [],
  presentation,
  repeated = 1,
  modelSwitch = null,
}: {
  headline: string;
  tone: 'danger' | 'warning';
  details: string | null;
  // 合并的卡片写次数和最近一次的时间，例如「共 3 次 · 最近 21:38」。
  meta?: string | null;
  actions?: Array<{ label: string; onPress: () => void }>;
  presentation?: Pick<FailurePresentation, 'form' | 'label' | 'quote' | 'summary' | 'facts'>;
  // 合成一张的同一种失败一共几次。
  repeated?: number;
  // 能重发时：Lead 现在用的模型，和「换个模型重发」的入口（画布「没有回答」状态 2）。
  // 入口由会话传进来（LeadModelPicker 的 LeadModelResendLink）：这张卡不依赖运行时，测试和工单对话里也能单独用。
  modelSwitch?: { current: string; link: ReactNode } | null;
}) {
  if (!presentation) return <NoticeRow testID="failure-card" tone={tone} title={headline} meta={meta} actions={actions} details={details} />;
  if (presentation.form === 'system') {
    const next = presentation.facts.find((fact) => fact.label === '接下来')?.value;
    return <SystemLine testID="failure-card" repeated={repeated > 1} icon="warning" lead={presentation.label} text={[meta, next].filter(Boolean).join(' · ') || null} />;
  }
  if (presentation.form === 'tail') return <AbsenceTail testID="failure-card" text={presentation.label} actions={actions} />;
  const reason = presentation.facts.find((fact) => fact.label === '原因')?.value ?? null;
  const facts: Array<{ label: string; value: ReactNode; mono?: boolean }> = presentation.facts.map((fact) => (
    fact.label === '原因' && modelSwitch ? { label: fact.label, value: <ReasonWithModel reason={fact.value} {...modelSwitch} /> } : fact
  ));
  if (modelSwitch && !presentation.facts.some((fact) => fact.label === '原因')) {
    facts.unshift({ label: '模型', value: <ReasonWithModel reason={null} {...modelSwitch} /> });
  }
  return (
    <Absence
      testID="failure-card"
      tone={tone}
      label={presentation.label}
      text={presentation.summary ?? (presentation.quote ? `你问的「${shortQuote(presentation.quote)}」` : reason)}
      actions={actions.map((action) => (RESEND_LABELS.has(action.label) ? { ...action, icon: 'refresh' as const } : action))}
      details={[...facts, ...(details ? [{ label: '原文', value: details, mono: true }] : [])]}
    />
  );
}

// 「原因」一行：原因 · 现在用的模型和推理强度 · 换个模型重发。
function ReasonWithModel({ reason, current, link }: { reason: string | null; current: string; link: ReactNode }) {
  const model = leadModelLabel(current);
  return (
    <Row testID="failure-card-model" items="center" gap="icon-label" flexWrap="wrap">
      <Text size="secondary">{[reason, model.id, model.effort].filter(Boolean).join(' · ')}</Text>
      <Text size="secondary" tone="secondary">·</Text>
      {link}
    </Row>
  );
}

// 再来一次的按钮前面画一个刷新图标（画布「重发」）；「删除」「打开工单」不画。
const RESEND_LABELS = new Set([FAILURE_ACTION_LABELS.resend, FAILURE_ACTION_LABELS.retry]);

// 引用你那句话：一行放得下的长度，多了用省略号。
function shortQuote(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}
