import { Box, Button, Column, Dot, Icon, Row, Spacer, SystemLine, Text, type ColorToken, type TextTone } from '@pi-lead-child/components';
import {
  ticketNeedsUser, type KernelCheckpoint, type LeadStatus, type TicketStatus, type TicketSummary,
} from '@pi-lead-child/protocol';

import { leadNameNow } from '../../state/leadName';
import { isRuntimeRecoveryActive, ticketSummaryToTicket } from '../workspace/model';
import { FailureCard } from './FailureCard';
import { presentRunFailureCheckpoint, presentSystemCheckpoint } from './failurePresentation';

const checkpointKindLabel: Record<KernelCheckpoint['kind'], string> = {
  progress: '进展',
  milestone: '阶段完成',
  decision: '方向调整',
  delegation: '已委派',
  blocked: '需要介入',
  completed: '已提交复核',
};

export type CheckpointCardViewModel = {
  sourceLabel: string;
  kindLabel: string;
  tone: 'accent' | 'success' | 'warning' | 'danger';
  title: string;
  summary: string;
  stage: string | null;
  facts: KernelCheckpoint['keyFacts'];
  artifactRefs: string[];
  relatedTicketIds: number[];
  nextStep: string | null;
  // 工单后来变了时的小标签「现在：…」。卡片本身只写事件当时的状态（kindLabel）。
  nowLabel: string | null;
  currentStateHint: string | null;
};

export function buildCheckpointCardViewModel(
  checkpoint: KernelCheckpoint,
  currentTicket?: TicketSummary,
): CheckpointCardViewModel {
  return {
    sourceLabel: checkpointSourceLabel(checkpoint),
    kindLabel: checkpointKindLabel[checkpoint.kind],
    tone: checkpoint.kind === 'blocked'
      ? 'danger'
      : checkpoint.kind === 'completed' || checkpoint.kind === 'milestone'
        ? 'success'
        : checkpoint.kind === 'decision'
          ? 'warning'
          : 'accent',
    title: checkpointDisplayTitle(checkpoint),
    summary: checkpoint.summary,
    stage: checkpoint.stage,
    facts: checkpoint.keyFacts.map((fact) => ({ label: fact.label, value: fact.value })),
    artifactRefs: [...checkpoint.artifactRefs],
    relatedTicketIds: [...checkpoint.relatedTicketIds],
    nextStep: checkpoint.nextStep,
    nowLabel: checkpointNowLabel(checkpoint, currentTicket),
    currentStateHint: checkpointCurrentStateHint(checkpoint, currentTicket),
  };
}

export function CheckpointCard({
  checkpoint,
  currentTicket,
  lead,
  onOpenTicket,
  showOpenTicket = true,
}: {
  checkpoint: KernelCheckpoint;
  currentTicket?: TicketSummary;
  // 现在的 Lead 健康状态（GET /v1/overview 的 lead）。Run 失败的说法要看它。
  lead?: LeadStatus;
  onOpenTicket: (ticketId: number) => void;
  showOpenTicket?: boolean;
}) {
  const leadHandling = currentTicket?.attention.leadHandling === true && currentTicket.attention.blockerCount === 0;
  const failure = presentRunFailureCheckpoint(checkpoint, {
    lead, settled: runFailureSettled(checkpoint, currentTicket), leadHandling,
    escalated: (currentTicket?.attention.blockerCount ?? 0) > 0,
  });
  const nowLabel = checkpointNowLabel(checkpoint, currentTicket);
  // 系统写的检查点（Run 被收回、启动失败、崩溃……）：模式「系统信息行」，居中一行中文（2026-10-27 用户）。
  // 要你处理时图标红色、行尾「打开工单」；原文（写给 Lead 的英文和键值）点开再看。
  const system = presentSystemCheckpoint(checkpoint, {
    lead, settled: runFailureSettled(checkpoint, currentTicket), leadHandling,
    escalated: (currentTicket?.attention.blockerCount ?? 0) > 0, nowLabel,
  });
  if (system) {
    const time = formatCheckpointTime(checkpoint.createdAt);
    return (
      <Box testID={`checkpoint-card-${checkpoint.id}`} w="100%" py="banner-y">
        <SystemLine
          testID={`checkpoint-line-${checkpoint.id}`}
          icon={system.ok ? 'progress' : 'warning'}
          iconTone={system.needsUser ? 'danger' : 'secondary'}
          text={time ? `${system.text} · ${time}` : system.text}
          details={system.details}
          {...(system.needsUser ? { action: { label: `打开工单 #${checkpoint.ticketId}`, onPress: () => onOpenTicket(checkpoint.ticketId), tone: 'danger' as const } } : {})}
        />
      </Box>
    );
  }
  if (failure && !failure.needsUser) {
    // 不需要你做什么的失败（系统在重试、Lead 在处理、已经过去了）：弱反馈，只是一行（2026-10-15 用户决定）。
    return (
      <Column testID={`checkpoint-card-${checkpoint.id}`} w="100%" gap="text-stack" py="banner-y">
        {/* spacing-exempt: 光学对齐 */}
        <Row items="center" gap="icon-label" pl={2}>
          <Dot color={TONE_DOT.warning} size={6} />
          <Text size="label" weight="semibold" tone="secondary">{failure.label}</Text>
          {nowLabel ? <NowChip label={nowLabel} /> : null}
          <Spacer />
          <Text size="meta" mono weight="semibold" tone="secondary">{`#${checkpoint.ticketId}`}</Text>
        </Row>
        {/* spacing-exempt: 缩进到圆点之后 */}
        <Text size="secondary" tone="secondary" pl={15}>{failure.headline}</Text>
      </Column>
    );
  }
  if (failure) {
    // 系统记下的、需要你处理的 Run 失败：一句白话，键值表和写给 Lead 的下一步在展开以后。
    const tone = failure.tone === 'danger' ? 'danger' : 'warning';
    return (
      <Column testID={`checkpoint-card-${checkpoint.id}`} w="100%" gap="reply-block" py="banner-y">
        <Text size="meta" weight="semibold" tone="secondary">{checkpointSourceLabel(checkpoint)}</Text>
        {/* spacing-exempt: 光学对齐 */}
        <Row items="center" gap="icon-label" pl={2}>
          <Dot color={TONE_DOT[tone]} size={7} />
          <Text size="label" weight="bold" tone={TONE_TEXT[tone]}>{failure.label}</Text>
          {nowLabel ? <NowChip label={nowLabel} /> : null}
          <Spacer />
          <Text size="meta" mono weight="semibold" tone="secondary">{`#${checkpoint.ticketId}`}</Text>
        </Row>
        <FailureCard
          headline={failure.headline}
          tone={failure.tone}
          details={failure.details}
          actions={failure.needsUser || showOpenTicket
            ? [{ label: `打开工单 #${checkpoint.ticketId}`, onPress: () => onOpenTicket(checkpoint.ticketId) }]
            : []}
        />
      </Column>
    );
  }
  const model = buildCheckpointCardViewModel(checkpoint, currentTicket);
  // 会话栏是白底：进展通知铺一层浅底，和 Lead 的正文分开。不加边框和阴影，比待处理的介入卡片轻一档。
  return (
    <Column testID={`checkpoint-card-${checkpoint.id}`} w="100%" gap="card-section" px="card" py="card" rounded="xl" bg="surface-subtle">
      <Text size="meta" weight="semibold" tone="secondary">{model.sourceLabel}</Text>
      {/* spacing-exempt: 光学对齐 */}
      <Column gap="card-row" pl={2}>
        <Row items="center" gap="icon-label">
          <Dot color={TONE_DOT[model.tone]} size={7} />
          <Text size="label" weight="bold" tone={TONE_TEXT[model.tone]}>{model.kindLabel}</Text>
          {model.stage ? <Text size="meta" mono tone="secondary">{model.stage}</Text> : null}
          {model.nowLabel ? <NowChip label={model.nowLabel} /> : null}
          <Spacer />
          <Text size="meta" mono weight="semibold" tone="secondary">{`#${checkpoint.ticketId}`}</Text>
        </Row>
        {model.currentStateHint ? <Text size="secondary" tone="secondary">{model.currentStateHint}</Text> : null}
        <Text size="card-title" weight="bold">{model.title}</Text>
        <Text size="secondary" tone="secondary">{model.summary}</Text>
        {model.facts.length > 0 ? (
          // spacing-exempt: 光学对齐
          <Column gap="stacked-card" pt={2}>
            {model.facts.map((fact) => (
              <Row key={`${fact.label}:${fact.value}`} items="baseline" gap="inline-item">
                <Text size="label" weight="medium" tone="secondary">{fact.label}</Text>
                <Text size="code" mono weight="semibold">{fact.value}</Text>
              </Row>
            ))}
          </Column>
        ) : null}
        {model.nextStep ? (
          <Row items="flex-start" gap="icon-label" pt="card" borderTopWidth={1} borderTopColor="border-soft">
            <Icon name="arrow-right" color="text-secondary" size={13} />
            <Text flex={1} size="secondary" weight="medium" tone="secondary">{model.nextStep}</Text>
          </Row>
        ) : null}
        {model.artifactRefs.length > 0 ? (
          <Column gap="stacked-card">
            {model.artifactRefs.map((artifactId) => (
              <Text key={artifactId} size="code" mono weight="semibold" tone="accent">{`artifact · ${artifactId}`}</Text>
            ))}
          </Column>
        ) : null}
        {/* 没有按钮时不留空行：通知有底色，空行会多出一截下边距。 */}
        {model.relatedTicketIds.length > 0 || showOpenTicket ? (
          <Row minH={25} items="center" flexWrap="wrap" gap="actions">
            {model.relatedTicketIds.map((ticketId) => (
              <Button key={ticketId} label={`子工单 #${ticketId}`} onPress={() => onOpenTicket(ticketId)} variant="soft" tone="neutral" size="xs" />
            ))}
            <Spacer />
            {showOpenTicket ? (
              <Button label={`打开工单 #${checkpoint.ticketId}`} onPress={() => onOpenTicket(checkpoint.ticketId)} variant="link" />
            ) : null}
          </Row>
        ) : null}
      </Column>
    </Column>
  );
}

const TONE_DOT: Record<CheckpointCardViewModel['tone'], ColorToken> = {
  accent: 'accent',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
};

const TONE_TEXT: Record<CheckpointCardViewModel['tone'], TextTone> = {
  accent: 'accent',
  success: 'success-dark',
  warning: 'warning-dark',
  danger: 'danger-dark',
};

// 一次 Run 失败已经过去：工单后来结束了，或者阻塞的那次失败之后工单不再阻塞（例如恢复后又在跑）。
function runFailureSettled(checkpoint: KernelCheckpoint, currentTicket?: TicketSummary): boolean {
  if (!currentTicket) return false;
  const stage = currentTicket.stage;
  if (stage === 'done' || stage === 'cancelled' || stage === 'acked') return true;
  return checkpoint.kind === 'blocked' && stage !== 'blocked';
}

// 事件发生时它把工单放在哪个阶段：交付提交复核是 review，阻塞是 blocked，其余是在执行。
const EVENT_PHASE: Record<KernelCheckpoint['kind'], TicketStatus> = {
  progress: 'active', milestone: 'active', decision: 'active', delegation: 'active', blocked: 'blocked', completed: 'review',
};

/**
 * 历史卡片旁边的「现在：…」。以前卡片里一行粗体「当前工单：完成」挨着「已提交复核」，看起来像这条消息自己在说完成。
 * 只在工单后来变了时给：阶段不一样了（完成了、恢复中），或者它现在在等用户（例如核查不通过），而这件事本身不是阻塞。
 */
export function checkpointNowLabel(checkpoint: KernelCheckpoint, currentTicket?: TicketSummary): string | null {
  if (!currentTicket) return null;
  const phase = isRuntimeRecoveryActive(currentTicket) ? 'recovering' : currentTicket.stage;
  const moved = phase !== EVENT_PHASE[checkpoint.kind];
  const waitsForUser = checkpoint.kind !== 'blocked' && ticketNeedsUser(currentTicket) !== null;
  if (!moved && !waitsForUser) return null;
  return `现在：${ticketSummaryToTicket(currentTicket).statusLabel}`;
}

function NowChip({ label }: { label: string }) {
  return (
    // 白底：进展通知本身铺了 surface-subtle，小标签用白底加描边才看得出来。
    <Box testID="checkpoint-now-chip" px="pill-x" py="pill-y" rounded="full" borderWidth={1} borderColor="border" bg="surface">
      {/* spacing-exempt: 徽标字号 */}
      <Text size="10.5" weight="semibold" tone="secondary">{label}</Text>
    </Box>
  );
}

export function checkpointSourceLabel(checkpoint: KernelCheckpoint): string {
  const time = formatCheckpointTime(checkpoint.createdAt);
  if (checkpoint.source === 'system_derived' || checkpoint.author.kind === 'system') {
    return `系统更新${time ? ` · ${time}` : ''}`;
  }
  const role = checkpoint.author.kind === 'reviewer' ? 'reviewer' : 'child';
  const identity = checkpoint.attemptId === null ? role : `${role} #${checkpoint.attemptId}`;
  return `来自 ${identity} 的消息${time ? ` · ${time}` : ''}`;
}

export function checkpointDisplayTitle(checkpoint: KernelCheckpoint): string {
  if (checkpoint.title === 'Authorization approved, execution resumed') return '授权已记录，等待执行状态确认';
  return checkpoint.title;
}

export function checkpointCurrentStateHint(checkpoint: KernelCheckpoint, currentTicket?: TicketSummary): string | null {
  if (!currentTicket) return null;
  const current = ticketSummaryToTicket(currentTicket);
  if (checkpoint.title === 'Authorization approved, execution resumed' && current.status === 'blocked') {
    return `授权已经记录，但工单仍处于阻塞；等待 child/${leadNameNow()} 重新上报执行结果。`;
  }
  if (checkpoint.title === 'Authorization approved, execution resumed' && current.status === 'active') {
    return '授权已经记录，child 正在继续执行。';
  }
  return null;
}

export function formatCheckpointTime(value: string, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}
