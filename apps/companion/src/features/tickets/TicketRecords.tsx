import { Box, Button, Column, Row, ScrollArea, SegmentedControl, Text } from '@pi-lead-child/components';
import { useState } from 'react';

import { ArtifactList } from './ArtifactList';
import { CheckpointFeed } from './CheckpointFeed';
import { LogTimeline, RunLogGroups } from './LogTimeline';
import { PowPanel } from './PowPanel';
import { DetailEmpty, SectionHeader } from './TicketDetailLayout';
import { TicketHistorySections } from './TicketHistorySections';
import type { TicketThreadProps } from './TicketThread';
import { buildEvidencePresentation } from './ticketEvidence';
import { buildTicketDetailPresentation } from '@/features/workspace/model';

export type TicketRecordsTab = 'evidence' | 'progress' | 'runs' | 'lifecycle' | 'artifacts';

export type TicketRecordsProps = Pick<
  TicketThreadProps,
  | 'ticket' | 'checkpoints' | 'checkpointResource' | 'interventions' | 'interventionCommandStates'
  | 'onResolveIntervention' | 'resolutionError' | 'onRetryCheckpoints' | 'onOpenTicket' | 'runFacts'
  | 'pow' | 'outcome' | 'attempts' | 'logs' | 'logRuns' | 'lifecycle' | 'executionResource' | 'onRetryExecution'
  | 'artifacts' | 'artifactCapability' | 'artifactDownloadStates' | 'onDownloadArtifact' | 'onCancelArtifactDownload'
> & {
  onClose: () => void;
  /** page：桌面上占 Lead 会话栏，标题写工单号和标题。panel：手机上在工单面板里，页眉已经写了是哪张工单。 */
  variant: 'page' | 'panel';
};

// 「证据与记录」（方案 D）：验收、进展、Run 记录、生命周期和产物。以前它们和对话一起排在一条长页面里，
// 进展记录还在页面里自己再滚（520 px 的内层滚动区）。现在一个页签一块内容，整块只有一个滚动区。
export function TicketRecords({
  ticket,
  checkpoints = [],
  checkpointResource = { state: 'ready' },
  interventions = {},
  interventionCommandStates = {},
  onResolveIntervention,
  resolutionError = null,
  onRetryCheckpoints,
  onOpenTicket,
  runFacts,
  pow = null,
  outcome = null,
  attempts = [],
  logs = [],
  logRuns = [],
  lifecycle = [],
  executionResource,
  onRetryExecution,
  artifacts = [],
  artifactCapability = 'unsupported',
  artifactDownloadStates = {},
  onDownloadArtifact,
  onCancelArtifactDownload,
  onClose,
  variant,
}: TicketRecordsProps) {
  const [tab, setTab] = useState<TicketRecordsTab>('evidence');
  const evidence = buildEvidencePresentation(pow, outcome);
  // 产物的空状态（还在读、不支持、没有）和以前的产物页签同一个说法。
  const artifactState = buildTicketDetailPresentation(ticket, {
    timing: { elapsedMs: ticket.elapsedMs },
    artifactCapability,
    artifactCount: artifacts.length,
  }).artifactState;
  const ticketDisplayId = ticket.displayId ?? ticket.id;
  const options: { value: TicketRecordsTab; label: string }[] = [
    { value: 'evidence', label: evidence.needsAttention ? '验收 !' : '验收' },
    { value: 'progress', label: checkpoints.length > 0 ? `进展 ${checkpoints.length}` : '进展' },
    { value: 'runs', label: attempts.length > 0 ? `Run ${attempts.length}` : 'Run' },
    { value: 'lifecycle', label: '生命周期' },
    { value: 'artifacts', label: artifacts.length > 0 ? `产物 ${artifacts.length}` : '产物' },
  ];
  return (
    <Column testID="ticket-records" flex={1} minW={0} minH={0} bg="surface">
      <Column px="page-x" pt="card" pb="card" gap="card-row" borderBottomWidth={1} borderBottomColor="border-soft">
        <Row items="center" gap="inline-item">
          <Button
            label={variant === 'page' ? '收起' : '返回概览'}
            onPress={onClose}
            testID="ticket-records-close"
            variant="outline"
            tone="neutral"
            size="xs"
          />
          <Text size="section-title" weight="extrabold">证据与记录</Text>
          {variant === 'page' ? (
            <Row flex={1} minW={0} items="center" gap="inline-item">
              <Text size="meta" mono weight="bold" tone="strong">{`#${ticketDisplayId}`}</Text>
              <Box flex={1} minW={0}>
                <Text size="secondary" weight="semibold" tone="secondary" numberOfLines={1}>{ticket.title.replace(/^\[[^\]]+\]\s*/, '')}</Text>
              </Box>
            </Row>
          ) : null}
        </Row>
        <SegmentedControl
          testID="ticket-records-tabs"
          size="sm"
          options={options}
          value={tab}
          onChange={setTab}
          optionTestID={(value) => `ticket-records-tab-${value}`}
        />
      </Column>
      <ScrollArea testID="ticket-records-scroll" fillContent>
        <Column px="page-x" py="page-top" gap="page-section">
          {resolutionError ? (
            <Text role="alert" size="secondary" weight="medium" tone="danger-dark">{resolutionError}</Text>
          ) : null}
          {tab === 'evidence' ? <PowPanel pow={pow} outcome={outcome} /> : null}
          {tab === 'progress' ? (
            <CheckpointFeed
              checkpoints={checkpoints}
              interventions={interventions}
              interventionCommandStates={interventionCommandStates}
              resource={checkpointResource}
              onResolveIntervention={onResolveIntervention}
              onOpenTicket={onOpenTicket}
              onRetry={onRetryCheckpoints}
              ticketStatus={ticket.status}
              deliveryRunId={ticket.reviewState?.deliveryRunId}
              runs={runFacts}
            />
          ) : null}
          {tab === 'runs' ? (
            <Column gap="page-section">
              <TicketHistorySections
                flush
                sections={['attempts']}
                currentTicketId={ticket.id}
                lifecycle={lifecycle}
                attempts={attempts}
                relations={[]}
                executionResource={executionResource}
                onRetry={onRetryExecution}
              />
              <Column gap="card-section">
                <SectionHeader
                  title="运行日志"
                  count={[
                    logRuns.length > 1 ? `${logRuns.length} 次 Run` : null,
                    pow && pow.metrics.toolOperationCount > 0 ? `${pow.metrics.toolOperationCount} 次工具调用` : null,
                  ].filter(Boolean).join(' · ')}
                />
                {logRuns.length > 1
                  ? <RunLogGroups runs={logRuns} />
                  : logs.length > 0
                    ? <LogTimeline items={logs} />
                    : <DetailEmpty title="还没有日志" body="Run 的工具调用和事件到达后会显示在这里。" icon="document" />}
              </Column>
            </Column>
          ) : null}
          {tab === 'lifecycle' ? (
            <TicketHistorySections
              flush
              sections={['lifecycle']}
              currentTicketId={ticket.id}
              lifecycle={lifecycle}
              attempts={attempts}
              relations={[]}
              executionResource={executionResource}
              onRetry={onRetryExecution}
            />
          ) : null}
          {tab === 'artifacts' ? (
            artifacts.length > 0 && artifactCapability === 'available'
              ? (
                <ArtifactList
                  items={artifacts}
                  downloadStates={artifactDownloadStates}
                  onDownload={onDownloadArtifact}
                  onCancel={onCancelArtifactDownload}
                />
              )
              : <DetailEmpty title={artifactState.title} body={artifactState.body} icon="folder" />
          ) : null}
        </Column>
      </ScrollArea>
    </Column>
  );
}
