import { Column, Row, Text } from '@pi-lead-child/components';

import { formatCompactElapsed } from '@/features/workspace/model';

// 工单耗时。compact 时标签和数值在同一行。
export function TicketTiming({ elapsedMs, compact = false }: { elapsedMs: number | null | undefined; compact?: boolean }) {
  const value = formatCompactElapsed(elapsedMs) ?? '尚未开始';
  const Layout = compact ? Row : Column;
  return (
    <Layout aria-label={`耗时 ${value}`} minW={compact ? 0 : 92} items={compact ? 'center' : undefined} gap={compact ? 6 : 3}>
      <Text size="label" weight="bold" tone="muted">耗时</Text>
      <Text size={compact ? '11.5' : '12.5'} mono weight="bold" tone={compact ? 'secondary' : 'default'}>{value}</Text>
    </Layout>
  );
}
