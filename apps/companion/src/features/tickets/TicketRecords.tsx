import { Box, Button, Column, Row, ScrollArea, SegmentedControl, Text } from '@pi-lead-child/components';
import { useState } from 'react';

import { ArtifactList, PullRequestArtifact } from './ArtifactList';
import { CheckpointFeed } from './CheckpointFeed';
import { LogTimeline, RunLogGroups } from './LogTimeline';
import { PowPanel } from './PowPanel';
import { ticketPullRequest } from './pullRequestLink';
import { DetailEmpty, SectionHeader } from './TicketDetailLayout';
import { TicketHistorySections } from './TicketHistorySections';
import type { TicketThreadProps } from './TicketThread';
import { buildEvidencePresentation } from './ticketEvidence';
import { ticketRecordsMessages } from './ticketRecords.messages';
import { buildTicketDetailPresentation } from '@/features/workspace/model';
import { useLocale, useMessages } from '@/i18n';

export type TicketRecordsTab = 'evidence' | 'progress' | 'runs' | 'lifecycle' | 'artifacts';

export type TicketRecordsProps = Pick<
  TicketThreadProps,
  | 'ticket' | 'checkpoints' | 'checkpointResource' | 'interventions' | 'interventionCommandStates'
  | 'onResolveIntervention' | 'resolutionError' | 'onRetryCheckpoints' | 'onOpenTicket' | 'runFacts'
  | 'pow' | 'outcome' | 'deliveryNumbers' | 'attempts' | 'logs' | 'logRuns' | 'lifecycle' | 'executionResource' | 'onRetryExecution'
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
  deliveryNumbers,
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
  const locale = useLocale();
  const m = useMessages(ticketRecordsMessages);
  const [tab, setTab] = useState<TicketRecordsTab>('evidence');
  const evidence = buildEvidencePresentation(pow, outcome, locale, deliveryNumbers);
  // 产物的空状态（还在读、不支持、没有）和以前的产物页签同一个说法。
  const artifactState = buildTicketDetailPresentation(ticket, {
    timing: { elapsedMs: ticket.elapsedMs },
    artifactCapability,
    artifactCount: artifacts.length,
    locale,
  }).artifactState;
  const pullRequest = ticketPullRequest(ticket.workspace);
  const ticketDisplayId = ticket.displayId ?? ticket.id;
  const options: { value: TicketRecordsTab; label: string }[] = [
    { value: 'evidence', label: m.tabs.evidence(evidence.needsAttention) },
    { value: 'progress', label: m.tabs.progress(checkpoints.length) },
    { value: 'runs', label: m.tabs.runs(attempts.length) },
    { value: 'lifecycle', label: m.tabs.lifecycle },
    { value: 'artifacts', label: m.tabs.artifacts(artifacts.length + (pullRequest ? 1 : 0)) },
  ];
  return (
    <Column testID="ticket-records" flex={1} minW={0} minH={0} bg="surface">
      <Column px="page-x" pt="card" pb="card" gap="card-row" borderBottomWidth={1} borderBottomColor="border-soft">
        <Row items="center" gap="inline-item">
          <Button
            label={variant === 'page' ? m.collapse : m.backToOverview}
            onPress={onClose}
            testID="ticket-records-close"
            variant="outline"
            tone="neutral"
            size="xs"
          />
          <Text size="section-title" weight="extrabold">{m.title}</Text>
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
          {tab === 'evidence' ? <PowPanel pow={pow} outcome={outcome} deliveryNumbers={deliveryNumbers} /> : null}
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
                  title={m.runLogs}
                  count={[
                    logRuns.length > 1 ? m.runCount(logRuns.length) : null,
                    pow && pow.metrics.toolOperationCount > 0 ? m.toolCalls(pow.metrics.toolOperationCount) : null,
                  ].filter(Boolean).join(' · ')}
                />
                {logRuns.length > 1
                  ? <RunLogGroups runs={logRuns} />
                  : logs.length > 0
                    ? <LogTimeline items={logs} />
                    : <DetailEmpty title={m.noLogs} body={m.noLogsBody} icon="document" />}
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
            <Column gap="stacked-card">
              {pullRequest ? <PullRequestArtifact pullRequest={pullRequest} /> : null}
              {artifacts.length > 0 && artifactCapability === 'available'
                ? (
                  <ArtifactList
                    items={artifacts}
                    downloadStates={artifactDownloadStates}
                    onDownload={onDownloadArtifact}
                    onCancel={onCancelArtifactDownload}
                  />
                )
                : pullRequest ? null : <DetailEmpty title={artifactState.title} body={artifactState.body} icon="folder" />}
            </Column>
          ) : null}
        </Column>
      </ScrollArea>
    </Column>
  );
}
