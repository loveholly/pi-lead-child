import { Box, Button, Card, Column, Divider, Icon, ListItem, Row, Text, type IconName } from '@pi-lead-child/components';

import { useMessages } from '@/i18n';

import { useCompanionRuntime } from '../../state/CompanionStateProvider';
import {
  useApproval,
  useArtifactMetadata,
  useConversationItemDetail,
  useMessagePart,
  useStreamingText,
  useTicketSummary,
} from '../../state/hooks';
import type { MessageEntity } from '../../state/types';
import { ticketDisplayTitle, ticketSummaryToTicket } from '../workspace/model';

import { EmbeddedTicketCard } from './EmbeddedTicketCard';
import { MarkdownMessage } from './MarkdownMessage';
import { messagePartMessages } from './messagePart.messages';
import { ReminderCard } from './ReminderCard';
import { useOpenAgenda } from './useOpenAgenda';
import { useOpenTicket } from './useOpenTicket';
import { SurfaceView } from '../genui/SurfaceView';

type MessagePartViewProps = {
  messageId: string;
  partId: string;
  role: MessageEntity['role'];
  messageState: MessageEntity['state'];
  compact?: boolean;
  suppressedApprovalIds?: readonly number[];
  suppressedTicketIds?: readonly number[];
};

export function MessagePartView({
  messageId,
  partId,
  role,
  messageState,
  compact = false,
  suppressedApprovalIds = [],
  suppressedTicketIds = [],
}: MessagePartViewProps) {
  const part = useMessagePart(partId);
  const m = useMessages(messagePartMessages);
  if (!part) return null;

  if (part.kind === 'text') {
    return <TextMessagePart canonicalText={part.text} messageId={messageId} messageState={messageState} role={role} />;
  }

  // 工具调用画在这一轮的任务卡里（AssistantTurnView），不单独占一行。
  if (part.kind === 'tool') return null;

  if (part.kind === 'ticket') {
    if (suppressedTicketIds.includes(part.ticketId)) return null;
    return <TicketMessagePart compact={compact} ticketId={part.ticketId} />;
  }

  if (part.kind === 'approval') {
    if (suppressedApprovalIds.includes(part.approvalId)) return null;
    return <ApprovalMessagePart approvalId={part.approvalId} />;
  }

  if (part.kind === 'artifact') return <ArtifactMessagePart artifactId={part.artifactId} />;

  // Lead 用 render_ui 画的富交互卡片（generative UI）。
  if (part.kind === 'surface') return <SurfaceView surface={part.surface} partial={part.partial} callId={part.callId} />;

  // 你发的图片画在气泡上面一排（LeadConversation 的 UserMessageImages），不在气泡里。
  if (part.kind === 'image') return null;

  // 你引用的几段话由气泡自己画在正文上面（LeadConversation 的 QuoteBlock），不在这里画。
  if (part.kind === 'quote') return null;

  // 你发的文件画在气泡上面（LeadConversation 的 UserMessageFiles），不在气泡里。
  if (part.kind === 'file') return null;

  return (
    <InfoRow
      icon="agent"
      label={`Agent ${part.state}`}
      detail={part.ticketId ? m.ticketNumber(part.ticketId) : m.stateUpdated}
    />
  );
}

function TextMessagePart({ canonicalText, messageId, messageState, role }: {
  canonicalText: string;
  messageId: string;
  messageState: MessageEntity['state'];
  role: MessageEntity['role'];
}) {
  const streamingText = useStreamingText(messageId);
  const text = `${canonicalText}${streamingText ?? ''}`;
  if (!text && messageState !== 'streaming') return null;
  // 你发的消息和 Lead 的回复正文一样：语义字号 message-body，不设行高，用字体默认的行高（2026-10-21）。
  if (role !== 'assistant') {
    return role === 'user'
      ? <Text size="message-body">{text || '…'}</Text>
      : <Text size="body" tone="secondary">{text || '…'}</Text>;
  }
  return <MarkdownMessage markdown={text || '…'} hideInternalMarkers />;
}

// 工单列表只装 task：不在列表里的事项（提醒、刚建好的工单）按编号取它的 TicketDetail。提醒画成提醒卡。
function TicketMessagePart({ ticketId, compact }: { ticketId: number; compact: boolean }) {
  const ticketSummary = useTicketSummary(ticketId);
  const { detail, resource } = useConversationItemDetail(ticketId, !ticketSummary);
  const openTicket = useOpenTicket();
  const openAgenda = useOpenAgenda();
  const m = useMessages(messagePartMessages);
  const item = ticketSummary ?? detail?.ticket;
  if (item?.kind === 'reminder') {
    return (
      <ReminderCard
        view={{
          reminderId: ticketId, title: ticketDisplayTitle(item), remindAt: detail?.remindAt ?? null,
          stage: item.stage, event: null, fallback: null, level: detail?.reminder?.level ?? null,
        }}
      />
    );
  }
  if (!item) {
    return <InfoRow icon="ticket" label={`#${ticketId}`} detail={resource?.state === 'error' ? m.itemUnreadable : m.loading} />;
  }
  return (
    <EmbeddedTicketCard
      compact={compact}
      ticket={ticketSummaryToTicket(item)}
      onPress={() => openTicket(ticketId)}
    />
  );
}

function ApprovalMessagePart({ approvalId }: { approvalId: number }) {
  const runtime = useCompanionRuntime();
  const approval = useApproval(approvalId);
  const m = useMessages(messagePartMessages);
  if (!approval) return <InfoRow icon="approval-request" label={m.approvalNumber(approvalId)} detail={m.approvalSyncing} />;
  const pending = approval.status === 'pending';
  if (!pending) return <InfoRow icon="approval-request" label={m.approvalTool(approval.tool)} detail={approval.status} />;

  return (
    <Card gap="card-section" p="card" variant="float">
      <Row items="flex-start" gap="side-item">
        <Box w={30} h={30} rounded="md" bg="warning-soft" items="center" justify="center">
          <Icon name="approval" color="warning-dark" size={14} />
        </Box>
        <Column flex={1} minW={0} gap="text-stack">
          <Text size="card-title" weight="bold">{m.needsApproval(approval.tool)}</Text>
          <Text size="secondary" tone="secondary">{approval.action}</Text>
        </Column>
      </Row>
      <Row justify="flex-end" gap="actions">
        <Button label={m.reject} variant="outline" tone="neutral" size="sm" onPress={() => void runtime.resolveApproval(approval.id, 'reject')} />
        <Button label={m.approve} tone="inverse" size="sm" onPress={() => void runtime.resolveApproval(approval.id, 'approve')} />
      </Row>
    </Card>
  );
}

function ArtifactMessagePart({ artifactId }: { artifactId: string }) {
  const artifact = useArtifactMetadata(artifactId);
  return (
    <InfoRow
      icon="document"
      label={artifact?.name ?? 'Artifact'}
      detail={artifact ? [artifact.mediaType, artifact.size === null ? null : `${artifact.size} bytes`].filter(Boolean).join(' · ') : artifactId}
    />
  );
}

function InfoRow({ icon, label, detail }: { icon: IconName; label: string; detail: string }) {
  return (
    <Column>
      <ListItem
        title={label}
        subtitle={detail}
        leading={(
          <Box w={30} h={30} rounded="md" bg="accent-soft" items="center" justify="center">
            <Icon name={icon} color="accent" size={15} />
          </Box>
        )}
      />
      <Divider />
    </Column>
  );
}
