import {
  Avatar, Box, Button, Card, Column, EmptyState, ListItem, Row, Skeleton, Text, type IconName,
} from '@pi-lead-child/components';

import { useLeadName } from '@/state/hooks';
import type { InterventionCommandState } from '@/state/types';

import { timeLabel } from './timeLabels';
import {
  buildCheckpointFeedPresentation,
  type CheckpointFeedResource,
  type CheckpointRunFacts,
  type CheckpointPresentationInput,
  type InterventionActionId,
  type InterventionAuthority,
  type TicketStatus,
} from '@/features/workspace/model';

import { InterventionPanel } from './InterventionPanel';

type CheckpointFeedProps = {
  checkpoints: CheckpointPresentationInput[];
  interventions?: Record<string, InterventionAuthority>;
  interventionCommandStates?: Record<string, InterventionCommandState>;
  resource?: CheckpointFeedResource & { pagination?: CheckpointFeedPagination };
  onResolveIntervention?: (interventionId: string, actionId: InterventionActionId, customResponse?: string) => void;
  onOpenTicket?: (ticketId: string) => void;
  onRetry?: () => void;
  /** 工单当前的 stage：用来区分"现在需要介入"和"当时阻塞过"。 */
  ticketStatus?: TicketStatus;
  /** 正在等待验收的那次交付；只有它的提交记录才算"等待验收"。 */
  deliveryRunId?: number | null;
  /** 每次 Run 的用途和它有没有让工单阻塞：没让工单阻塞的失败不写「当时阻塞」。 */
  runs?: CheckpointRunFacts;
};

export type CheckpointFeedPagination = {
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  onLoadOlder?: () => void;
};

export function CheckpointFeed({
  checkpoints,
  interventions = {},
  interventionCommandStates = {},
  resource = { state: 'ready' },
  onResolveIntervention,
  onOpenTicket,
  onRetry,
  ticketStatus,
  deliveryRunId,
  runs,
}: CheckpointFeedProps) {
  const leadName = useLeadName();
  const feed = buildCheckpointFeedPresentation(checkpoints, interventions, resource, { ticketStatus, deliveryRunId, runs });
  const pagination = resource.pagination;

  if (feed.state === 'loading') {
    return (
      <Card aria-label="正在读取关键进展" gap="card-row" p="card" borderColor="border-soft" rounded="2xl">
        <Skeleton w="72%" h={12} rounded="full" />
        <Skeleton w="44%" h={10} rounded="full" />
      </Card>
    );
  }
  if (feed.state === 'empty') return <FeedEmpty icon="inbox" title="这张工单还没有关键进展" body="child 在关键阶段提交进度记录后会显示在这里。" />;
  if (feed.state === 'disconnected') return <FeedEmpty icon="offline" title="等待重新连接" body={`连接 ${leadName} 后读取这张工单的真实关键进展。`} />;
  if (feed.state === 'error') return <FeedEmpty icon="error-outline" title="进展读取失败" body={feed.pageError ?? '暂时无法读取进度记录。'} actionLabel="重试" onAction={onRetry} />;

  return (
    <Column>
      {resource.state === 'disconnected' ? (
        <Text px="section-label-x" size="secondary" weight="bold" tone="warning-dark">显示已缓存进展 · 等待重新连接</Text>
      ) : null}
      {pagination && (pagination.hasMore || pagination.loading || pagination.error) ? (
        <Column items="center" gap="card-row" py="banner-y">
          {pagination.error ? (
            <Text role="alert" size="secondary" tone="danger-dark" align="center">{`更早的进展加载失败：${pagination.error}`}</Text>
          ) : null}
          <Button
            accessibilityLabel={pagination.loading ? '正在加载更早的进展' : '加载更早的进展'}
            disabled={pagination.loading || !pagination.onLoadOlder}
            label={pagination.loading ? '正在加载更早的进展…' : pagination.error ? '重试加载更早的进展' : '加载更早的进展'}
            onPress={pagination.onLoadOlder}
            testID="checkpoint-load-older"
            variant="outline"
            tone="neutral"
            shape="pill"
            size="sm"
          />
        </Column>
      ) : null}
      {feed.items.map((checkpoint) => (
        <Column
          key={checkpoint.id}
          pb="stacked-card"
          borderBottomWidth={1}
          borderBottomColor="border-soft"
          {...(checkpoint.kind === 'blocked' && !checkpoint.historical
            ? { pl: 10, borderLeftWidth: 3, borderLeftColor: 'danger' } as const
            : {})}
        >
          <ListItem
            testID={`checkpoint-${checkpoint.id}`}
            title={checkpoint.title}
            subtitle={[checkpoint.sourceLabel, checkpoint.kindLabel, checkpoint.stage].filter(Boolean).join(' · ')}
            subtitleLines={2}
            leading={<Avatar label={checkpoint.source === 'system_derived' ? 'S' : 'π'} size={24} tone="surface" textSize="11" />}
            trailing={<Text size="meta" mono tone="faint">{timeLabel(checkpoint.createdAt)}</Text>}
          />
          <Text px="row-x" size="body" tone="secondary">{checkpoint.summary}</Text>
          {checkpoint.keyFacts && checkpoint.keyFacts.length > 0 ? (
            <Column gap="card-row" mt="card-row">
              {checkpoint.keyFacts.map((fact, index) => (
                <Row key={`${fact.label}-${index}`} items="baseline" gap="inline-item">
                  <Text size="label" weight="bold" tone="muted">{fact.label}</Text>
                  {/* spacing-exempt: 光学对齐 */}
                  <Text mt={3} size="code" mono weight="bold">{fact.value}</Text>
                </Row>
              ))}
            </Column>
          ) : null}
          {checkpoint.artifactRefs && checkpoint.artifactRefs.length > 0 ? (
            <Row flexWrap="wrap" gap="chips" mt="card-row">
              {checkpoint.artifactRefs.map((artifact) => (
                <Box key={artifact.id} px="pill-x" py="pill-y" rounded="md" bg="accent-soft">
                  {/* spacing-exempt: 徽标字号 */}
                  <Text size="10.5" mono tone="accent">{artifact.label}</Text>
                </Box>
              ))}
            </Row>
          ) : null}
          {checkpoint.relatedTicketIds && checkpoint.relatedTicketIds.length > 0 ? (
            <Row flexWrap="wrap" gap="actions" mt="card-row">
              {checkpoint.relatedTicketIds.map((ticketId) => (
                <Button
                  key={ticketId}
                  accessibilityLabel={`打开关联工单 #${ticketId}`}
                  disabled={!onOpenTicket}
                  label={`#${ticketId}`}
                  onPress={() => onOpenTicket?.(ticketId)}
                  testID={`related-ticket-${ticketId}`}
                  variant="outline"
                  tone="neutral"
                  size="xs"
                />
              ))}
            </Row>
          ) : null}
          {checkpoint.nextStep ? (
            <Row mt="card-section" pt="card-section" borderTopWidth={1} borderTopColor="border-soft" items="flex-start" gap="inline-item">
              <Text size="label" weight="bold">下一步</Text>
              <Text flex={1} minW={0} size="secondary" tone="secondary">{checkpoint.nextStep}</Text>
            </Row>
          ) : null}
          {checkpoint.intervention ? <InterventionPanel commandState={interventionCommandStates[checkpoint.intervention.id]} intervention={checkpoint.intervention} onResolve={onResolveIntervention} /> : null}
        </Column>
      ))}
      {feed.pageError ? (
        <Row items="center" gap="side-item" px="banner-x" py="banner-y" rounded="lg" bg="warning-soft">
          <Text flex={1} minW={0} size="secondary" tone="warning-dark">{`更早的进展读取失败：${feed.pageError}`}</Text>
          {onRetry ? (
            <Button accessibilityLabel="重试读取更早进展" label="重试" onPress={onRetry} testID="checkpoint-page-retry" variant="link" size="xs" />
          ) : null}
        </Row>
      ) : null}
    </Column>
  );
}

function FeedEmpty({ icon, title, body, actionLabel, onAction }: { icon: IconName; title: string; body: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <Column minH={230} items="center" justify="center">
      <EmptyState
        icon={icon}
        iconColor="text-muted"
        iconBackground="surface-muted"
        title={title}
        body={body}
        action={actionLabel && onAction ? { label: actionLabel, onPress: onAction, testID: 'checkpoint-empty-retry' } : undefined}
      />
    </Column>
  );
}
