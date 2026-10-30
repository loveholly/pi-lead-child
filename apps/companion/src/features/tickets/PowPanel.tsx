import { Box, Button, Column, Row, Text, type ColorToken, type TextTone } from '@pi-lead-child/components';
import type { KernelOutcomeSnapshotResource, KernelTicketPow } from '@pi-lead-child/protocol';
import { useState } from 'react';

import { buildEvidencePresentation, type EvidenceRow, type EvidenceState } from './ticketEvidence';

const SUMMARY_COLORS: Record<'muted' | 'attention' | 'passed', { bg: ColorToken; border: ColorToken; text: TextTone }> = {
  muted: { bg: 'surface-muted', border: 'border', text: 'secondary' },
  attention: { bg: 'warning-cream', border: 'warning-line', text: 'warning-dark' },
  passed: { bg: 'success-soft', border: 'success-border', text: 'success-dark' },
};

const ROW_MARK: Record<EvidenceState, { mark: string; bg: ColorToken; tone: TextTone }> = {
  passed: { mark: '✓', bg: 'success-soft', tone: 'success' },
  failed: { mark: '×', bg: 'danger-soft', tone: 'danger' },
  pending: { mark: '!', bg: 'warning-soft', tone: 'warning' },
  not_run: { mark: '–', bg: 'surface-muted', tone: 'muted' },
};

function EvidenceRows({ rows }: { rows: EvidenceRow[] }) {
  return (
    <Column>
      {rows.map((row) => {
        const mark = ROW_MARK[row.state];
        return (
          <Row key={row.id} minH={52} items="flex-start" gap="side-item" pb="stacked-card">
            <Box w={20} h={20} shrink={0} rounded="xs" items="center" justify="center" bg={mark.bg}>
              {/* spacing-exempt: 文字当图标用 */}
              <Text size="12" weight="extrabold" tone={mark.tone}>{mark.mark}</Text>
            </Box>
            <Column minW={0} flex={1}>
              <Text size="card-title" weight="bold">{row.label}</Text>
              <Text mt="text-stack" size="secondary" tone="secondary">
                {row.state === 'not_run' ? `未运行 · ${row.detail}` : row.detail}
              </Text>
            </Column>
          </Row>
        );
      })}
    </Column>
  );
}

// 验收证据：最新交付的证据在上面，更早 Run 的条目按 Run 折叠在下面（F6）。
// 条目状态只用数据里的状态；不再用正则把 agent 的借口改判成"环境限制"（F7）。
export function PowPanel({ pow, outcome }: { pow: KernelTicketPow | null; outcome?: KernelOutcomeSnapshotResource | null }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  if (!pow && !outcome?.latest) {
    return (
      <Column testID="pow-panel" py="banner-y" borderBottomWidth={1} borderBottomColor="border-soft">
        <Text size="card-title" weight="bold">当前 daemon 未提供 PoW 投影</Text>
        <Text mt="text-stack" size="secondary" tone="muted">Checkpoint 仍会保留在下方，不会推测验证结果。</Text>
      </Column>
    );
  }
  const evidence = buildEvidencePresentation(pow, outcome);
  const colors = SUMMARY_COLORS[evidence.summary.tone];
  return (
    <Column testID="pow-panel">
      <Row
        minH={48}
        items="center"
        gap="side-item"
        px="banner-x"
        py="banner-y"
        mb={evidence.current.length > 0 || evidence.history.length > 0 ? 16 : 0}
        borderWidth={1}
        rounded="xl"
        bg={colors.bg}
        borderColor={colors.border}
      >
        <Box w={24} h={24} shrink={0} rounded="full" bg="surface" items="center" justify="center">
          {/* spacing-exempt: 文字当图标用 */}
          <Text size="12" weight="extrabold" tone={colors.text}>{evidence.summary.mark}</Text>
        </Box>
        <Text flex={1} minW={0} size="card-title" weight="extrabold" tone={colors.text}>{evidence.summary.title}</Text>
      </Row>
      {evidence.current.length > 0 ? (
        <>
          <Text mb="group-label" size="eyebrow" weight="extrabold" tone="secondary">{evidence.currentTitle}</Text>
          <EvidenceRows rows={evidence.current} />
        </>
      ) : null}
      {evidence.history.length > 0 ? (
        <Column testID="pow-history" gap="group-label">
          <Row items="center" justify="space-between" gap="side-item">
            <Text size="eyebrow" weight="extrabold" tone="secondary">{`历史证据 · ${evidence.history.length} 次 Run`}</Text>
            <Button
              label={historyOpen ? '收起' : '展开'}
              onPress={() => setHistoryOpen((open) => !open)}
              testID="pow-history-toggle"
              variant="link"
              size="xs"
            />
          </Row>
          {historyOpen ? evidence.history.map((group) => (
            <Column key={group.attemptId ?? 'system'} gap="group-label">
              <Text size="eyebrow" weight="bold" tone="faint">{group.title}</Text>
              <EvidenceRows rows={group.rows} />
            </Column>
          )) : null}
        </Column>
      ) : null}
    </Column>
  );
}
