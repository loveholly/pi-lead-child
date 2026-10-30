import { Box, Button, Card, Column, Icon, Pressable, Row, Text, TextField, type ButtonTone, type ButtonVariant } from '@pi-lead-child/components';
import { useState } from 'react';
import type {
  KernelCheckpoint,
  KernelIntervention,
  KernelInterventionRef,
  ResolveKernelInterventionRequest,
} from '@pi-lead-child/protocol';
import { ticketNeedsUserLabel } from '@pi-lead-child/protocol';

import type { InterventionCommandState } from '../../state/types';
import { checkpointDisplayTitle, checkpointSourceLabel } from './CheckpointCard';
import { MarkdownMessage } from './MarkdownMessage';
import { resolvedByLabel } from './resolvedByLabel';
import { DisclosureView } from '../genui/Disclosure';

export type InterventionActionKey =
  | 'approve'
  | 'reject'
  | 'approve_session'
  | 'respond'
  | 'dismiss'
  | `option:${string}`;

type InterventionActionViewModel = {
  id: InterventionActionKey;
  label: string;
  tone: 'primary' | 'secondary' | 'danger';
};

export type InterventionCardViewModel = {
  title: string;
  detail: string;
  stateLabel: string;
  pending: boolean;
  actions: InterventionActionViewModel[];
  /** 处理结果。来自 Lead 或 child 的回答是 Markdown，卡片按 Markdown 渲染。 */
  resolutionText: string | null;
  /** 谁处理的，给人看的说法（Lead 的名字、「你」、「系统」）。和结果分开放：结果可能以表格结尾。 */
  resolvedByLabel: string | null;
};

const stateLabel: Record<KernelIntervention['state'], string> = {
  pending: '需要你介入',
  approved: '已授权',
  rejected: '已拒绝',
  resolved: '已解决',
  dismissed: '已暂缓',
  expired: '已过期',
};

export function buildInterventionCardViewModel(intervention: KernelIntervention, leadName: string): InterventionCardViewModel {
  const actions: InterventionActionViewModel[] = intervention.kind === 'approval'
    ? intervention.actions.map((action) => ({
      id: action,
      label: action === 'approve'
        ? '授权并让它继续'
        : action === 'approve_session'
          ? '本工单同类免批'
          : '拒绝',
      tone: action === 'approve' ? 'primary' : action === 'reject' ? 'danger' : 'secondary',
    }))
    : intervention.actions.map((action, index) => ({
      id: action.kind === 'select' ? `option:${action.optionId}` : action.kind,
      label: action.label,
      tone: action.kind === 'dismiss' ? 'secondary' : index === 0 ? 'primary' : 'secondary',
    }));

  return {
    title: intervention.title,
    detail: intervention.detail,
    // 等你处理的介入和收件箱、状态标签同一种说法：「待你决定」「待审批」（2026-10-16）。
    stateLabel: intervention.state === 'pending'
      ? ticketNeedsUserLabel(intervention.kind === 'approval' ? 'approval' : 'decision')
      : stateLabel[intervention.state],
    pending: intervention.state === 'pending',
    actions,
    resolutionText: interventionResolutionText(intervention, leadName),
    resolvedByLabel: intervention.state === 'pending' || intervention.state === 'expired'
      ? null
      : resolvedByLabel(intervention.resolvedBy, leadName),
  };
}

export function buildInterventionEvidence(checkpoint?: KernelCheckpoint): KernelCheckpoint['keyFacts'] {
  return checkpoint?.keyFacts.map((fact) => ({ label: fact.label, value: fact.value })) ?? [];
}

export function interventionDisplayTitle(
  model: Pick<InterventionCardViewModel, 'title'> | null,
  checkpoint?: KernelCheckpoint,
): string | null {
  return checkpoint ? null : model?.title ?? null;
}

export function buildInterventionActionCommand(
  intervention: KernelIntervention,
  action: InterventionActionKey,
  response?: string,
): ResolveKernelInterventionRequest {
  if (intervention.state !== 'pending') throw new Error('该介入请求已不再等待处理');
  if (intervention.kind === 'approval') {
    if (action !== 'approve' && action !== 'reject' && action !== 'approve_session') {
      throw new Error('审批操作无效');
    }
    if (!intervention.actions.includes(action)) throw new Error('审批操作当前不可用');
    return { authority: 'approval', decision: action };
  }

  if (action.startsWith('option:')) {
    const optionId = action.slice('option:'.length);
    const offered = intervention.actions.some((candidate) =>
      candidate.kind === 'select' && candidate.optionId === optionId);
    if (!offered) throw new Error('决策选项当前不可用');
    return { authority: 'decision_request', decision: 'select', optionId };
  }
  if (action === 'respond') {
    if (!intervention.actions.some((candidate) => candidate.kind === 'respond')) {
      throw new Error('自定义回复当前不可用');
    }
    const resolution = response?.trim() ?? '';
    if (!resolution) throw new Error('请输入回复内容');
    return { authority: 'decision_request', decision: 'respond', resolution };
  }
  if (action === 'dismiss') {
    if (!intervention.actions.some((candidate) => candidate.kind === 'dismiss')) {
      throw new Error('暂不处理当前不可用');
    }
    return { authority: 'decision_request', decision: 'dismiss' };
  }
  throw new Error('决策操作无效');
}

// 2026-10-27 按画布「child 来信」重画（对象组件 Intervention → 模式「审批」「决定」「结束行」，主题 11.3–11.5）：
//   待审批：头部一行（琥珀点、「待审批」、child #160 要做什么，右边时间和等了多久）；命令放在灰底等宽的框里；
//     三个按钮按后果从轻到重：授权这一次（主按钮）、本工单同类免批、拒绝。
//   待决定：选项是单选行，代价写在同一行；操作是「就这样定」「自己写一句」「先不管」。
//   已解决：收成一行（结束行：✓ 已解决、一句结果、时间、展开），点开从原位置撑开成浮层，看回答（通用 Markdown，表格在框里横向滚动）。
// 不再用整片红底和左边的色条（主题 C-18）。命令原文只能引用（P8.3）：显示的就是请求里的 detail。
export function InterventionCard({
  checkpoint,
  commandState,
  compact = false,
  showOpenTicket = true,
  intervention,
  leadName,
  onOpenTicket,
  onResolve,
}: {
  checkpoint?: KernelCheckpoint;
  commandState?: InterventionCommandState;
  compact?: boolean;
  showOpenTicket?: boolean;
  intervention?: KernelIntervention | KernelInterventionRef;
  // Lead 的名字（useLeadName）。过期的请求写「等待 <名字> 重新评估」。
  leadName: string;
  onOpenTicket: (ticketId: number) => void;
  onResolve?: (command: ResolveKernelInterventionRequest) => Promise<void>;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [response, setResponse] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const full = intervention && isFullIntervention(intervention) ? intervention : undefined;
  const model = full ? buildInterventionCardViewModel(full, leadName) : null;
  const ticketId = intervention?.ticketId ?? checkpoint?.ticketId;
  const pending = full?.state === 'pending' || (!full && intervention !== undefined && 'requiresAction' in intervention && intervention.requiresAction);
  const submitting = commandState?.state === 'pending';
  const error = commandState?.state === 'error' ? commandState.error : validationError;
  const disabled = submitting || !onResolve;
  void compact;

  const execute = (action: InterventionActionKey, customResponse?: string) => {
    if (!full || disabled || !onResolve) return;
    setValidationError(null);
    let command: ResolveKernelInterventionRequest;
    try {
      command = buildInterventionActionCommand(full, action, customResponse);
    } catch (reason) {
      setValidationError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    void onResolve(command).catch(() => {});
  };

  const who = ticketId !== undefined ? `child #${ticketId}` : 'child';
  if (model && !model.pending) {
    const summary = resolvedSummary(model, full!, requestWords(full!, checkpoint));
    return (
      <Card w="100%" rounded="xl" overflow="hidden" borderWidth={1} borderColor="border" testID={`intervention-${full!.id}`}>
        <DisclosureView
          id={`intervention-${full!.id}`}
          label={`${who} ${requestWords(full!, checkpoint)}`}
          partial={false}
          summary={(
            <EndLine
              state={model.stateLabel}
              tone={full!.state === 'rejected' || full!.state === 'expired' || full!.state === 'dismissed' ? 'muted' : 'success'}
              subject={who}
              result={summary}
              at={full!.resolvedAt}
            />
          )}
          panel={(
            <Column>
              <EndLine state={model.stateLabel} tone="success" subject={who} result={summary} at={full!.resolvedAt} open />
              <Column px="card" pb="card" gap="card-row">
                <MarkdownMessage markdown={model.resolutionText ?? model.title} size="body" />
                <CheckpointEvidence checkpoint={checkpoint} />
                <Row items="center" gap="inline-item">
                  {model.resolvedByLabel ? (
                    <Text testID="intervention-resolved-by" size="meta" tone="secondary">
                      {`${model.resolvedByLabel} 回答${full!.resolvedAt ? ` · ${clock(full!.resolvedAt)}` : ''}`}
                    </Text>
                  ) : null}
                  {ticketId !== undefined ? <Button label={`打开工单 #${ticketId}`} onPress={() => onOpenTicket(ticketId)} variant="link" size="xs" /> : null}
                </Row>
              </Column>
            </Column>
          )}
        />
        {/* 会话外（例如工单详情）照旧可以直接打开工单。 */}
        {showOpenTicket && ticketId !== undefined ? (
          <Box px="card" pb="card-row"><Button label={`打开工单 #${ticketId}`} onPress={() => onOpenTicket(ticketId)} variant="link" size="xs" /></Box>
        ) : null}
      </Card>
    );
  }

  if (!pending && ticketId !== undefined) {
    return (
      <Card w="100%" rounded="xl" borderWidth={1} borderColor="border">
        <EndLine state="介入已更新" tone="muted" subject={who} result={checkpoint?.title ?? `工单 #${ticketId}`} at={null} />
        <Column px="card" pb="card" gap="card-row">
          <CheckpointEvidence checkpoint={checkpoint} />
          {showOpenTicket ? <TicketButton ticketId={ticketId} onOpenTicket={onOpenTicket} /> : null}
        </Column>
      </Card>
    );
  }

  const decision = full && full.kind !== 'approval' ? full : null;
  const options = decision?.options ?? [];
  const optionActions = model?.actions.filter((action) => action.id.startsWith('option:')) ?? [];
  const otherActions = model?.actions.filter((action) => !action.id.startsWith('option:')) ?? [];
  const chosen = selected ?? (optionActions[0]?.id.slice('option:'.length) ?? null);
  const waited = full ? waitedWords(full.createdAt) : null;
  return (
    <Column w="100%" gap="group-label">
      {checkpoint && !full ? <SourceLabel>{checkpointSourceLabel(checkpoint)}</SourceLabel> : null}
      <Card w="100%" rounded="xl" borderWidth={1} borderColor="border" p="card" gap="card-row" testID={full ? `intervention-${full.id}` : undefined}>
        {/* 头部：琥珀点、「待审批」「待你决定」、child #160 要做什么，右边时间和等了多久（主题 11.4）。 */}
        <Row items="center" gap="inline-item" minW={0}>
          <Box w={6} h={6} rounded="full" bg="warning" />
          <Text size="label" weight="bold" tone="warning-dark" shrink={0}>{model?.stateLabel ?? '需要你介入'}</Text>
          <Text flex={1} minW={0} size="card-title" numberOfLines={2}>
            <Text size="card-title" weight="bold">{who}</Text>
            {`${full && full.kind !== 'approval' ? '：' : ' '}${full ? requestWords(full, checkpoint) : checkpoint?.title ?? ''}`}
          </Text>
          {full ? <Text size="meta" tone="secondary" shrink={0}>{[clock(full.createdAt), waited].filter(Boolean).join(' · ')}</Text> : null}
        </Row>
        {full?.kind === 'approval' ? (
          // 要执行的命令原样引用：灰底、等宽（主题 11.4）；child 对这一步的说明（checkpoint 的摘要）跟在同一行。
          <Row items="center" gap="inline-item" flexWrap="wrap" minW={0}>
            <Row self="flex-start" maxW="100%" bg="surface-muted" rounded="md" px="inset-x" py="inset-y" testID="intervention-command">
              <Text size="code" mono numberOfLines={3}>{`$ ${full.detail}`}</Text>
            </Row>
            {checkpoint?.summary ? <Text size="meta" tone="secondary" numberOfLines={1}>{checkpoint.summary}</Text> : null}
          </Row>
        ) : full ? null : (
          <MarkdownMessage markdown={checkpoint?.summary ?? '正在同步可操作详情。'} size="secondary" tone="secondary" />
        )}
        {options.length ? (
          // 单选行：选项名 600，代价写在同一行；选中的行 accent-wash 底（主题 11.3）。
          <Column role="radiogroup" gap="text-stack">
            {options.map((option) => {
              const on = option.id === chosen;
              const offered = optionActions.some((action) => action.id === `option:${option.id}`);
              return (
                <Pressable
                  key={option.id}
                  role="radio"
                  aria-checked={on}
                  aria-label={option.label}
                  disabled={!offered || disabled}
                  onPress={() => setSelected(option.id)}
                  feedback="highlight"
                  rounded="md"
                  px="inset-x"
                  minH={34}
                  justify="center"
                  bg={on ? 'accent-wash' : 'surface'}
                  testID={`intervention-option-${option.id}`}
                >
                  <Row items="center" gap="inline-item">
                    <Box w={14} h={14} rounded="full" borderWidth={on ? 4 : 1.5} borderColor={on ? 'accent' : 'border-strong'} bg="surface" />
                    <Text size="body" weight="semibold">{option.label}</Text>
                    {option.description ? <Text flex={1} minW={0} size="secondary" tone="secondary" numberOfLines={1}>{option.description}</Text> : null}
                  </Row>
                </Pressable>
              );
            })}
          </Column>
        ) : null}
        <CheckpointEvidence checkpoint={checkpoint} />
        {commandState?.state === 'succeeded' ? (
          <Text size="note" weight="medium" tone="success-dark">操作已提交，正在同步权威状态。</Text>
        ) : null}
        {!full ? (
          <Text size="note" weight="medium" tone="warning-dark">当前连接没有返回可操作详情；不会根据安全引用推测或代替你执行。</Text>
        ) : null}
        {customOpen && full && full.kind !== 'approval' && full.state === 'pending' ? (
          <Column gap="card-row">
            <TextField
              value={response}
              onChangeText={setResponse}
              disabled={disabled}
              multiline
              height={70}
              size="sm"
              placeholder="写给 child 的一句明确决定"
            />
            <Row gap="actions">
              <ActionButton disabled={disabled} label={submitting ? '提交中…' : '提交决定'} onPress={() => execute('respond', response)} tone="primary" />
              <ActionButton disabled={disabled} label="取消" onPress={() => setCustomOpen(false)} tone="quiet" />
            </Row>
          </Column>
        ) : model?.actions.length ? (
          // 审批：按后果从轻到重；决定：「就这样定」用选中的那一项，再是自己写一句、先不管。
          <Row flexWrap="wrap" gap="actions">
            {full?.kind === 'approval' ? APPROVAL_ORDER.flatMap((id) => model.actions.filter((action) => action.id === id)).map((action) => (
              <ActionButton
                key={action.id}
                disabled={disabled}
                label={submitting ? '提交中…' : APPROVAL_LABELS[action.id] ?? action.label}
                onPress={() => execute(action.id)}
                tone={action.id === 'approve' ? 'primary' : action.id === 'approve_session' ? 'secondary' : 'quiet'}
              />
            )) : (
              <>
                {optionActions.length ? (
                  <ActionButton
                    disabled={disabled || !chosen}
                    label={submitting ? '提交中…' : '就这样定'}
                    onPress={() => chosen && execute(`option:${chosen}`)}
                    tone="primary"
                  />
                ) : null}
                {otherActions.map((action) => (
                  <ActionButton
                    key={action.id}
                    disabled={disabled}
                    label={action.id === 'respond' ? '自己写一句' : action.id === 'dismiss' ? '先不管' : action.label}
                    onPress={() => {
                      if (action.id === 'respond') setCustomOpen(true);
                      else execute(action.id);
                    }}
                    tone="quiet"
                  />
                ))}
              </>
            )}
          </Row>
        ) : null}
        {error ? <Text size="note" weight="medium" tone="danger-dark">{error}</Text> : null}
        {showOpenTicket && ticketId !== undefined ? <TicketButton ticketId={ticketId} onOpenTicket={onOpenTicket} /> : null}
      </Card>
    </Column>
  );
}

// 审批的三个按钮：按后果从轻到重（画布 child 状态 1）。
const APPROVAL_ORDER: readonly InterventionActionKey[] = ['approve', 'approve_session', 'reject'];
const APPROVAL_LABELS: Partial<Record<InterventionActionKey, string>> = { approve: '授权这一次', approve_session: '本工单同类免批', reject: '拒绝' };

function clock(at: string | null): string | null {
  if (!at) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// 「等了 4 分钟」：从请求发出到现在。
function waitedWords(createdAt: string): string | null {
  const ms = Date.now() - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < 60_000) return null;
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `等了 ${minutes} 分钟` : minutes < 1440 ? `等了 ${Math.round(minutes / 60)} 小时` : `等了 ${Math.round(minutes / 1440)} 天`;
}

// child 要什么，用它自己的话：审批是 child 写的那一步（checkpoint 的标题），决定和提问是它问的那句。
// 内核的 title（「Approval required: bash」）只是占位，没有别的话时才用。
function requestWords(intervention: KernelIntervention, checkpoint?: KernelCheckpoint): string {
  if (intervention.kind === 'approval') return checkpoint ? checkpointDisplayTitle(checkpoint) : intervention.title;
  return intervention.detail.trim() || (checkpoint ? checkpointDisplayTitle(checkpoint) : intervention.title);
}

// 结束行的一句结果：child 要什么 · 谁回答了（回答里有表格时写附几张表）。
function resolvedSummary(model: InterventionCardViewModel, intervention: KernelIntervention, request: string): string {
  const tables = (model.resolutionText?.match(/^\s*\|.*\|\s*\n\s*\|[\s:|-]+\|/gm) ?? []).length;
  const by = model.resolvedByLabel ? `${model.resolvedByLabel} 已回答${tables ? `，附 ${tables} 张表` : ''}` : model.stateLabel;
  return intervention.kind === 'approval' ? `${request} · ${model.resolutionText ?? model.stateLabel}` : `${request} · ${by}`;
}

// 结束行（P9.4，主题 11.5）：状态图标加状态词、对象、一句结果、时间、展开箭头。
function EndLine({ state, tone, subject, result, at, open = false }: {
  state: string; tone: 'success' | 'muted'; subject: string; result: string; at: string | null; open?: boolean;
}) {
  return (
    <Row items="center" gap="inline-item" px="card" minH={42} minW={0}>
      <Row items="center" gap="text-stack" shrink={0} rounded="full" px="inline-item" bg={tone === 'success' ? 'success-soft' : 'surface-muted'}>
        <Icon name="check" size={10} color={tone === 'success' ? 'success-dark' : 'text-secondary'} weight="bold" />
        <Text size="meta" weight="semibold" tone={tone === 'success' ? 'success-dark' : 'secondary'}>{state}</Text>
      </Row>
      <Text size="label" weight="bold" shrink={0}>{subject}</Text>
      <Text flex={1} minW={0} size="secondary" tone="strong" numberOfLines={1}>{result}</Text>
      {clock(at) ? <Text size="meta" tone="secondary" shrink={0}>{clock(at)}</Text> : null}
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} color="text-muted" />
    </Row>
  );
}

function SourceLabel({ children }: { children: string }) {
  return <Text size="eyebrow" weight="semibold" tone="secondary">{children}</Text>;
}

function CheckpointEvidence({ checkpoint }: { checkpoint?: KernelCheckpoint }) {
  const evidence = buildInterventionEvidence(checkpoint);
  if (evidence.length === 0) return null;
  return (
    <Column w="100%" borderTopWidth={1} borderTopColor="border-soft">
      <Text size="eyebrow" weight="bold" tone="secondary">诊断证据</Text>
      {evidence.map((fact, index) => (
        <Row key={`${fact.label}:${index}`} minH={32} items="flex-start" gap="inline-item" py="row-y" borderTopWidth={1} borderTopColor="border-soft">
          <Box w={70} shrink={0}>
            <Text size="code" mono weight="semibold" tone="secondary">{fact.label}</Text>
          </Box>
          <Box flex={1} minW={0}>
            <Text size="code" mono tone="secondary">{fact.value}</Text>
          </Box>
        </Row>
      ))}
    </Column>
  );
}

const ACTION_STYLE: Record<InterventionActionViewModel['tone'] | 'quiet', { variant: ButtonVariant; tone: ButtonTone }> = {
  primary: { variant: 'solid', tone: 'accent' },
  secondary: { variant: 'outline', tone: 'neutral' },
  danger: { variant: 'outline', tone: 'danger' },
  quiet: { variant: 'ghost', tone: 'neutral' },
};

function ActionButton({ disabled, label, onPress, tone }: {
  disabled: boolean;
  label: string;
  onPress: () => void;
  tone: InterventionActionViewModel['tone'] | 'quiet';
}) {
  return <Button disabled={disabled} label={label} onPress={onPress} size="sm" testID={label} {...ACTION_STYLE[tone]} />;
}

function TicketButton({ ticketId, onOpenTicket }: { ticketId: number; onOpenTicket: (ticketId: number) => void }) {
  return (
    <Box self="flex-start">
      <Button label={`打开工单 #${ticketId}`} onPress={() => onOpenTicket(ticketId)} variant="link" />
    </Box>
  );
}

function isFullIntervention(
  intervention: KernelIntervention | KernelInterventionRef,
): intervention is KernelIntervention {
  return 'title' in intervention && 'actions' in intervention;
}

function interventionResolutionText(intervention: KernelIntervention, leadName: string): string | null {
  if (intervention.state === 'pending') return null;
  if (intervention.state === 'expired') return `请求已过期，等待 ${leadName} 重新评估。`;
  if (intervention.kind === 'approval') {
    if (!intervention.resolution) return stateLabel[intervention.state];
    const decision = intervention.resolution.decision === 'reject'
      ? '已拒绝'
      : intervention.resolution.sessionExempt
        ? '已授权，本工单同类操作免批'
        : '已授权本次操作';
    return decision;
  }
  if (!intervention.resolution) return stateLabel[intervention.state];
  const value = intervention.resolution.kind === 'option'
    ? intervention.options.find((option) => option.id === intervention.resolution?.optionId)?.label
    : intervention.resolution.kind === 'text'
      ? intervention.resolution.text
      : '已暂不处理';
  return value ?? null;
}
