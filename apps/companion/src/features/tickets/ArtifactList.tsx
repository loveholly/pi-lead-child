import { Box, Card, Column, Icon, ListItem, Text } from '@pi-lead-child/components';
import type { KernelArtifact } from '@pi-lead-child/protocol';

import type { ArtifactDownloadState } from '@/state/types';

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
  return (
    <Column testID="artifact-list" gap="stacked-card">
      {items.map((artifact) => {
        const state = downloadStates[artifact.id];
        const available = artifact.availability === 'available';
        const downloading = state?.state === 'downloading';
        const label = !available
          ? artifact.availability === 'metadata_only' ? '仅元数据' : '不可用'
          : downloading ? '取消' : state?.state === 'error' ? '重试' : state?.state === 'succeeded' ? '已下载' : '下载';
        const meta = [
          artifact.kind,
          artifact.byteLength === null ? null : formatBytes(artifact.byteLength),
          !available ? label : downloading ? '下载中' : state?.state === 'error' ? '下载失败' : state?.state === 'succeeded' ? '下载完成' : null,
        ].filter(Boolean).join(' · ');
        const onPress = !available
          ? undefined
          : downloading
            ? onCancel ? () => onCancel(artifact.id) : undefined
            : onDownload ? () => onDownload(artifact.id) : undefined;
        return (
          <Card
            key={artifact.id}
            aria-label={`${label} ${artifact.name}${state?.state === 'error' && state.error ? `，${state.error}` : ''}`}
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

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
