import { Badge, Box, Button, Card, Column, Pressable, Row, ScrollArea, Text } from '@pi-lead-child/components';
import { useState } from 'react';

import type { TicketLogPresentation } from './ticketLogs';
import { clockTimeLabel, timeRangeLabel } from './timeLabels';

export type TicketLogRunPresentation = {
  id: number;
  /** 这次 Run 是做什么的：执行、核查、对话。 */
  purposeLabel: string;
  /** runtime、模型和 effort 合成的一行（ticketHistory 的 choice）。 */
  choice: string;
  startedAt: string;
  endedAt: string | null;
  result: string;
  logs: TicketLogPresentation[];
};

// 一次 Run 的日志时间线：左侧状态圆点，右侧标题、状态、预览；有详情的条目可以展开。
export function LogTimeline({ items }: { items: TicketLogPresentation[] }) {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  return (
    <Column testID="log-timeline">
      {items.map((log, index) => {
        const failed = log.status === 'failed';
        const success = log.status === 'success';
        const running = log.status === 'running';
        const expanded = Boolean(expandedIds[log.id]);
        return (
          <Row key={log.id} minH={76} gap="timeline">
            <Column w={22} items="center">
              <Box
                w={22}
                h={22}
                shrink={0}
                rounded="full"
                items="center"
                justify="center"
                bg={failed ? 'danger-soft' : success ? 'success-soft' : 'accent-soft'}
              >
                <Box w={6} h={6} rounded="full" bg={failed ? 'danger' : success ? 'success' : 'accent'} />
              </Box>
              {/* spacing-exempt: 轨道线和标记的间隙 */}
              {index < items.length - 1 ? <Box flex={1} w={2} mt={4} bg="border-soft" /> : null}
            </Column>
            <Column testID={`ticket-log-${log.id}`} flex={1} minW={0} pb="timeline-event">
              <Row items="flex-start" gap="inline-item">
                <Text
                  flex={1}
                  minW={0}
                  numberOfLines={2}
                  size={log.monospaceTitle ? '12' : '12.5'}
                  mono={log.monospaceTitle}
                  weight="bold"
                  leading={18} // spacing-exempt: 文字当图标用
                >
                  {log.title}
                </Text>
                <Badge label={log.statusLabel} tone={failed ? 'danger' : success ? 'success' : 'accent'} size="sm" />
              </Row>
              {log.meta ? <Text mt="text-stack" size="meta" mono tone="muted">{log.meta}</Text> : null}
              {log.preview ? (
                <Box mt="text-stack" p={failed ? 8 : 0} bg={failed ? 'danger-soft' : 'transparent'}>
                  {failed
                    ? <Text size="code" mono tone="danger-dark">{log.preview}</Text>
                    : <Text size="secondary" tone="secondary">{log.preview}</Text>}
                </Box>
              ) : null}
              {expanded && log.detail ? (
                <Box testID={`ticket-log-detail-${log.id}`} mt="card-row" bg="surface-muted">
                  <ScrollArea flex={0} maxH={420} nested>
                    <Text px="inset-x" py="inset-y" size="code" mono tone="secondary">{log.detail}</Text>
                  </ScrollArea>
                </Box>
              ) : null}
              <Row minH={28} mt="card-row" items="center" gap="inline-item">
                <Box minW={42}>
                  <Text size="meta" mono tone="faint">
                    {clockTimeLabel(log.createdAt)}
                  </Text>
                </Box>
                {log.detail ? (
                  <Button
                    label={expanded ? '收起' : log.expandLabel}
                    onPress={() => setExpandedIds((current) => ({ ...current, [log.id]: !expanded }))}
                    testID={`ticket-log-toggle-${log.id}`}
                    variant="link"
                    size="xs"
                  />
                ) : null}
                {running ? <Text size="label" weight="bold" tone="accent">执行中</Text> : null}
              </Row>
            </Column>
          </Row>
        );
      })}
    </Column>
  );
}

// 按 Run 分组的日志。默认展开最新的一次 Run。
export function RunLogGroups({ runs }: { runs: TicketLogRunPresentation[] }) {
  const [expandedRunId, setExpandedRunId] = useState<number | null>(runs.at(-1)?.id ?? null);

  if (runs.length === 0) return null;

  const visibleRunId = runs.some((run) => run.id === expandedRunId)
    ? expandedRunId
    : runs.at(-1)?.id ?? null;

  return (
    <Column testID="run-log-groups" gap="stacked-card">
      {runs.slice().reverse().map((run) => {
        const expanded = run.id === visibleRunId;
        return (
          <Card key={run.id} testID={`run-log-group-${run.id}`} borderColor="border-soft" rounded="md">
            <Pressable
              testID={`run-log-toggle-${run.id}`}
              aria-label={expanded ? '收起' : '展开'}
              aria-expanded={expanded}
              onPress={() => setExpandedRunId(expanded ? null : run.id)}
              feedback="highlight"
              w="100%"
              minH={58}
              px="card"
              py="card"
              rounded="md"
              justify="center"
            >
              <Row w="100%" items="center" gap="icon-label">
                <Column minW={0} flex={1} items="flex-start" gap="text-stack">
                  <Text size="card-title" weight="bold">{`Run #${run.id} · ${run.purposeLabel} · ${run.result}`}</Text>
                  <Text size="meta" mono tone="muted">
                    {`${run.choice} · ${timeRangeLabel(run.startedAt, run.endedAt)} · ${run.logs.length} 条日志`}
                  </Text>
                </Column>
                {/* spacing-exempt: 文字当图标用 */}
                <Text shrink={0} size="16" weight="bold" leading={18} tone="muted">{expanded ? '⌃' : '⌄'}</Text>
              </Row>
            </Pressable>
            {expanded ? (
              <Column testID={`run-log-content-${run.id}`} px="card" pb="card" borderTopWidth={1} borderTopColor="border-soft">
                {run.logs.length > 0
                  ? <LogTimeline items={run.logs} />
                  : <Text py="banner-y" size="secondary" tone="muted">还没有日志</Text>}
              </Column>
            ) : null}
          </Card>
        );
      })}
    </Column>
  );
}
