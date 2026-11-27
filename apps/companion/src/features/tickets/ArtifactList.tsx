import { Box, Card, Column, Icon, ListItem, Text, openURL } from '@pi-lead-child/components';
import type { KernelArtifact } from '@pi-lead-child/protocol';

import { useMessages } from '@/i18n';
import type { ArtifactDownloadState } from '@/state/types';

import type { TicketPullRequest } from './pullRequestLink';
import { ticketRecordsMessages } from './ticketRecords.messages';

// 工单产物列表。可用的产物可以下载；下载中可以取消，失败可以重试。
export function ArtifactList({
  items,
  downloadStates = {},
  onDownload,
  onCancel,
}: {
  items: KernelArtifact[];
  downloadStates?: Record<number, ArtifactDownloadState>;
  onDownload?: (artifactId: number) => void;
  onCancel?: (artifactId: number) => void;
}) {
  const messages = useMessages(ticketRecordsMessages);
  const m = messages.artifact;
  return (
    <Column testID="artifact-list" gap="stacked-card">
      {items.map((artifact) => {
        const state = downloadStates[artifact.id];
        const available = artifact.availability === 'available';
        const downloading = state?.state === 'downloading';
        const label = !available
          ? artifact.availability === 'metadata_only' ? m.metadataOnly : m.unavailable
          : downloading ? messages.cancel : state?.state === 'error' ? messages.retry : state?.state === 'succeeded' ? m.downloaded : m.download;
        const meta = [
          artifact.kind,
          artifact.byteLength === null ? null : formatBytes(artifact.byteLength),
          !available ? label : downloading ? m.downloading : state?.state === 'error' ? m.downloadFailed : state?.state === 'succeeded' ? m.downloadDone : null,
        ].filter(Boolean).join(' · ');
        const onPress = !available
          ? undefined
          : downloading
            ? onCancel ? () => onCancel(artifact.id) : undefined
            : onDownload ? () => onDownload(artifact.id) : undefined;
        return (
          <Card
            key={artifact.id}
            aria-label={m.label(label, artifact.name, state?.state === 'error' && state.error ? state.error : null)}
            minH={60}
            overflow="hidden"
            borderColor="border-soft"
            boxShadow="0 1px 3px rgba(16,24,40,0.04)"
          >
            <ListItem
              testID={downloading ? `artifact-cancel-${artifact.id}` : state?.state === 'error' ? `artifact-retry-${artifact.id}` : `artifact-download-${artifact.id}`}
              onPress={onPress}
              mono
              title={artifact.name}
              subtitle={meta}
              leading={(
                <Box w={36} h={36} rounded="lg" bg="accent-soft" items="center" justify="center">
                  <Icon name="document" color="accent" size={17} />
                </Box>
              )}
              trailing={<Text size="label" weight="bold" tone={available ? 'accent' : 'faint'}>{label}</Text>}
            />
          </Card>
        );
      })}
    </Column>
  );
}

// 工单登记的 PR：产物区里的一行，点一下在 GitHub 上打开。样子和文件产物同一张卡。
export function PullRequestArtifact({ pullRequest }: { pullRequest: TicketPullRequest }) {
  const m = useMessages(ticketRecordsMessages).pullRequest;
  return (
    <Card
      testID="ticket-pull-request"
      aria-label={m.label(pullRequest.name)}
      minH={60}
      overflow="hidden"
      borderColor="border-soft"
      boxShadow="0 1px 3px rgba(16,24,40,0.04)"
    >
      <ListItem
        testID="ticket-pull-request-open"
        onPress={() => openURL(pullRequest.url)}
        mono
        title={pullRequest.name}
        subtitle={m.meta}
        leading={(
          <Box w={36} h={36} rounded="lg" bg="accent-soft" items="center" justify="center">
            <Icon name="arrow-up-right" color="accent" size={17} />
          </Box>
        )}
        trailing={<Text size="label" weight="bold" tone="accent">{m.open}</Text>}
      />
    </Card>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
