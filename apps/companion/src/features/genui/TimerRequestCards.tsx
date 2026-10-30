import { Box, Button, Column, Dot, Row, Text } from '@pi-lead-child/components';
import type { TimerRequestDecision, TimerRequestDto } from '@pi-lead-child/protocol';
import { useCallback, useEffect, useState } from 'react';

import { shortTime, standingOrderErrorText } from '@/features/settings/standingOrderModel';
import { waitedText } from '@/features/workspace/inboxModel';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useConnectionPhase, useLeadName } from '@/state/hooks';

// 外部的人要求设的定时器的确认卡（统一的消息事件 spec D16，工单 12）。代价不够低时，Lead 把系统给的 user_action
// （confirm_timer）原样放进 UserAction，卡片只带确认号：什么定时器、谁要求的、为什么问你、代价的拆解都从
// /v1/timer-requests/:id 读（docs/design P8.1、P8.3：卡的外壳和内容由系统画，Lead 改不了）。
// 「设定时器」「不设」走只有用户能按到的路由（approvals:respond），是操作层的 timer_request.resolve（user_direct）。
// 样子照改规则的确认卡（RuleChangeCards.tsx），是审批模式（P9.2，主题 11.4）：头部是状态点和状态词、谁要求的、等了多久；
// 定时器本身放在白底、1px 边框的框里（要替你做的事）；原因、代价、来源是左边一列宽 56 的标签加右边的值；
// 操作组右对齐，只有「设定时器」是主按钮。处理过以后操作组原地换成结果（P5.5）。

type StateLook = { label: string; dot: 'warning' | 'accent' | 'success' | 'danger' | 'text-faint'; tone: 'warning-dark' | 'accent' | 'success-dark' | 'danger-dark' | 'secondary' };

// 状态按主题的五类状态画（P7.1，主题 C-11 到 C-15）。
const STATE: Record<TimerRequestDto['state'], StateLook> = {
  pending: { label: '等你决定', dot: 'warning', tone: 'warning-dark' },
  running: { label: '正在设', dot: 'accent', tone: 'accent' },
  done: { label: '已设', dot: 'success', tone: 'success-dark' },
  failed: { label: '没设成', dot: 'danger', tone: 'danger-dark' },
  declined: { label: '没有设', dot: 'text-faint', tone: 'secondary' },
  expired: { label: '已过期', dot: 'text-faint', tone: 'secondary' },
};

// 主题 11.4：后果一列标签宽 56。
const LABEL_WIDTH = 56;
// sm 按钮的高度（Button.shared.ts 的 SIZES.sm）。
const BUTTON_ROW_HEIGHT = 32;

function errorStatus(reason: unknown): number | undefined {
  return typeof reason === 'object' && reason !== null ? (reason as { status?: number }).status : undefined;
}

function settledText(request: TimerRequestDto): string | null {
  switch (request.state) {
    case 'done':
      return `设好了，来源仍然是 ${request.requester}。可以在「等待中的提醒」里取消。`;
    case 'failed':
      return request.resultPreview;
    case 'declined':
      return '你点了「不设」，没有设这个定时器。';
    case 'expired':
      return '没有决定，过期作废了，没有设。';
    case 'running':
      return '你点了「设定时器」，正在设。';
    default:
      return null;
  }
}

// 代价的拆解：「第 5 档（最高）：受众 +3、延后执行 +1、到点后要对外做事 +1」。
function costText(request: TimerRequestDto): string {
  const steps = request.cost.steps.filter((step) => step.levels > 0).map((step) => `${step.label} +${step.levels}`);
  return `第 ${request.cost.level} 档（${request.cost.name}）${steps.length ? `：${steps.join('、')}` : ''}`;
}

export function TimerRequestConfirmCard({ request: id }: { request: string }) {
  const runtime = useCompanionRuntime();
  // 连上 daemon 以后才读（刷新页面时设备可能还在重连）。
  const ready = useConnectionPhase() === 'ready';
  const [value, setValue] = useState<TimerRequestDto | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => runtime.timerRequest(id, signal).then(
    (request) => { if (!signal?.aborted) setValue(request); },
    (reason: unknown) => {
      if (signal?.aborted) return;
      if (errorStatus(reason) === 404) setGone(true);
      else setError(standingOrderErrorText(reason));
    },
  ), [id, runtime]);

  useEffect(() => {
    if (!ready) return undefined;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, ready]);

  if (gone) return <Text testID={`surface-timer-request-${id}-gone`} size="secondary" tone="secondary">找不到这张确认卡。</Text>;
  if (!value) {
    return error ? <Text size="secondary" tone="danger-dark">{error}</Text> : <Text size="secondary" tone="secondary">正在读取确认卡…</Text>;
  }
  return <TimerRequestConfirmView request={value} onChange={setValue} reload={load} />;
}

function TimerRequestConfirmView({ request, onChange, reload }: {
  request: TimerRequestDto;
  onChange: (next: TimerRequestDto) => void;
  reload: () => Promise<void>;
}) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const [submitting, setSubmitting] = useState<TimerRequestDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = `surface-timer-request-${request.id}`;
  const look = STATE[request.state];
  const pending = request.state === 'pending';

  const decide = (decision: TimerRequestDecision) => {
    setSubmitting(decision);
    setError(null);
    runtime.resolveTimerRequest(request.id, decision)
      .then(onChange, (reason: unknown) => {
        setError(standingOrderErrorText(reason));
        // 已经处理过或者过期了（409）：重读一次，显示它现在的状态。
        void reload();
      })
      .finally(() => setSubmitting(null));
  };

  const conversation = request.origin.kind === 'external' ? request.origin.conversation?.label ?? null : null;
  // 来源里有发信人：Lead 指明了是哪条消息要的，写「Ethan（Slack）要求设一个定时器」。没有发信人：只知道这一轮读了哪个对话，
  // 不写成谁要求的（2026-10-28：卡上写过「Aurum Huang（Slack）要求设一个定时器」，Aurum 根本没提定时器）。
  const named = request.origin.kind === 'external' && request.origin.sender !== null;
  const facts = [
    { label: '原因', value: request.reasons.join('；') },
    { label: '代价', value: costText(request) },
    ...(conversation ? [{ label: '来源', value: named ? conversation : `这一轮读过「${conversation}」里的消息，没有指明是谁要的` }] : []),
  ];
  const settled = settledText(request);
  return (
    <Column testID={id} gap="card-row">
      <Row items="center" gap="inline-item">
        <Row items="center" gap="icon-label" shrink={0}>
          <Dot color={look.dot} size={7} accessibilityLabel={look.label} />
          <Text testID={`${id}-state`} size="label" weight="semibold" tone={look.tone}>{look.label}</Text>
        </Row>
        <Text flex={1} minW={0} size="card-title" numberOfLines={1}>
          <Text size="card-title" weight="semibold">{named ? request.requester : leadName}</Text>
          {named ? ' 要求设一个定时器' : ' 要设一个定时器'}
        </Text>
        {/* 时刻用等宽字，「等了多久」不用（P14.2）。 */}
        <Text size="meta" tone="secondary" mono={!pending} shrink={0}>
          {pending ? `等了 ${waitedText(request.createdAt)}` : shortTime(request.resolvedAt ?? request.expiresAt)}
        </Text>
      </Row>
      <Box testID={`${id}-what`} px="inset-x" py="inset-y" rounded="md" bg="surface" borderWidth={1} borderColor="border">
        <Text size="body">{request.what}</Text>
      </Box>
      <Column gap="text-stack">
        {facts.map((fact) => (
          <Row key={fact.label} items="baseline" gap="side-item">
            <Text w={LABEL_WIDTH} shrink={0} size="label" weight="semibold" tone="secondary">{fact.label}</Text>
            <Text flex={1} minW={0} size="body">{fact.value}</Text>
          </Row>
        ))}
      </Column>
      {/* 操作行和处理以后的结果行一样高：卡片原地换状态时不变高（P1.3）。minH 是 sm 按钮的高度（Button.shared.ts）。 */}
      <Row items="center" justify={pending ? 'flex-end' : 'flex-start'} gap="actions" minH={BUTTON_ROW_HEIGHT}>
        {pending ? (
          <>
            <Button
              testID={`${id}-decline`} label={submitting === 'decline' ? '正在提交…' : '不设'} variant="ghost" tone="neutral" size="sm"
              disabled={submitting !== null} onPress={() => decide('decline')}
            />
            <Button
              testID={`${id}-confirm`} label={submitting === 'confirm' ? '正在设…' : '设定时器'} size="sm"
              disabled={submitting !== null} onPress={() => decide('confirm')}
            />
          </>
        ) : (
          <Text
            testID={`${id}-result`} flex={1} minW={0} size="secondary" numberOfLines={1}
            tone={request.state === 'failed' ? 'danger-dark' : 'secondary'}
          >
            {settled ?? ''}
          </Text>
        )}
      </Row>
      {error ? <Text testID={`${id}-error`} size="note" tone="danger-dark">{error}</Text> : null}
    </Column>
  );
}
