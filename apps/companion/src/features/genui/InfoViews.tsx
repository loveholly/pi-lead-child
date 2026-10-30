import {
  Badge, BarChart, DataTable, Pressable, Progress, Row, Stats, Steps, Text, Timeline,
  dataToneBadge, estimatedTextWidth, formatNumber, isNumericColumn, tableColumnWidth,
} from '@pi-lead-child/components';
import type { UiStepState, UiTableCell, UiTone } from '@pi-lead-child/protocol';

import { useTicketRef } from './useTicketRef';

// 组件目录 v2（2026-10-19 用户决定）：复杂的信息也用组件画，不只用在要用户做决定的地方。
// 表格里的工单只存编号，标题和状态实时读取（useTicketRef）。其余的数字和状态是 Lead 画卡时的快照，
// 不会自动更新：这里不画转圈、闪烁这类「还在进行」的动效，旧卡片不会显得像在实时变化。
// props 已经在 SurfaceView 里用 validateUiSurface 校验过。
// 指标、步骤、进度、时间线和条形图画在 packages/components 里（工单详情也用，2026-10-21）。
// 这里只把卡片里的节点转成组件的 props；卡片的 tone 和组件的 DataTone 是同样五个名字，直接传。

export type DataTableProps = {
  columns: Array<{ label: string; align?: 'left' | 'center' | 'right' }>;
  rows: UiTableCell[][];
};
export type StatsProps = {
  items: Array<{ label: string; value: number | string; unit?: string; change?: string; tone?: UiTone }>;
};
export type StepsProps = { items: Array<{ label: string; state: UiStepState; detail?: string }> };
export type ProgressProps = { label: string; value?: number; caption?: string; tone?: UiTone };
export type TimelineProps = { items: Array<{ at: string; text: string; tone?: UiTone }> };
export type BarChartProps = {
  bars: Array<{ label: string; value: number; tone?: UiTone }>;
  unit?: string;
  orientation?: 'horizontal' | 'vertical';
  max?: number;
};

// ——— 表格 ———

// 工单格子里有编号、标题和状态标签，按这个宽度排；放不下时标题截断。
const TICKET_COLUMN_WIDTH = 300;

function cellText(cell: UiTableCell): string {
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number') return formatNumber(cell);
  if ('badge' in cell) return cell.badge;
  return '';
}

// 和 Markdown 表格同一套样式（packages/components 的 DataTable）：列宽按最长的内容估，数字列右对齐、等宽。
export function DataTableView({ id, columns, rows }: DataTableProps & { id: string }) {
  const numeric = columns.map((_, column) => isNumericColumn(rows.map((row) => {
    const cell = row[column];
    return typeof cell === 'number' || typeof cell === 'string' ? cellText(cell) : 'x';
  })));
  const widths = columns.map((column, index) => {
    const hasTicket = rows.some((row) => { const cell = row[index]; return typeof cell === 'object' && 'ticket' in cell; });
    const widest = Math.max(
      estimatedTextWidth(column.label),
      ...rows.map((row) => {
        const cell = row[index];
        const text = estimatedTextWidth(cell === undefined ? '' : cellText(cell));
        return typeof cell === 'object' && 'badge' in cell ? text + 20 : text;
      }),
    );
    return hasTicket ? Math.max(TICKET_COLUMN_WIDTH, tableColumnWidth(widest)) : tableColumnWidth(widest);
  });
  return (
    <DataTable
      testID={`surface-table-${id}`}
      columnWidths={widths}
      align={columns.map((column, index) => column.align ?? (numeric[index] ? 'right' : null))}
      header={columns.map((column, index) => (
        <Text key={index} size="label" weight="semibold" tone="strong">{column.label}</Text>
      ))}
      rows={rows.map((row) => row.map((cell, index) => <TableCell key={index} cell={cell} numeric={numeric[index] ?? false} />))}
    />
  );
}

function TableCell({ cell, numeric }: { cell: UiTableCell; numeric: boolean }) {
  if (typeof cell === 'object' && 'ticket' in cell) return <TicketCell ticketId={cell.ticket} />;
  if (typeof cell === 'object') return <Badge label={cell.badge} tone={dataToneBadge[cell.tone ?? 'neutral']} />;
  if (numeric) return <Text mono size="body">{cellText(cell)}</Text>;
  return <Text size="body">{cellText(cell)}</Text>;
}

function TicketCell({ ticketId }: { ticketId: number }) {
  const ref = useTicketRef(ticketId);
  return (
    <Pressable testID={`surface-cell-ticket-${ticketId}`} aria-label={ref.label} onPress={ref.open} feedback="highlight" rounded="sm" w="100%">
      <Row items="center" gap="inline-item" minW={0}>
        <Text size="meta" mono tone="secondary" shrink={0}>{`#${ticketId}`}</Text>
        <Text flex={1} minW={0} size="card-title" weight="semibold" numberOfLines={1}>{ref.title}</Text>
        {ref.status ? <Badge label={ref.status} tone={ref.needs ? 'warning' : 'neutral'} /> : null}
      </Row>
    </Pressable>
  );
}

// ——— 指标、步骤、进度、时间线、条形图 ———

export function StatsView({ id, items }: StatsProps & { id: string }) {
  return <Stats testID={`surface-stats-${id}`} items={items} />;
}

export function StepsView({ id, items }: StepsProps & { id: string }) {
  return <Steps testID={`surface-steps-${id}`} items={items} />;
}

export function ProgressView({ id, label, value, caption, tone }: ProgressProps & { id: string }) {
  return <Progress testID={`surface-progress-${id}`} label={label} value={value} caption={caption} tone={tone} />;
}

export function TimelineView({ id, items }: TimelineProps & { id: string }) {
  return <Timeline testID={`surface-timeline-${id}`} items={items} />;
}

export function BarChartView({ id, bars, unit, orientation, max }: BarChartProps & { id: string }) {
  return <BarChart testID={`surface-bars-${id}`} bars={bars} unit={unit} orientation={orientation} max={max} />;
}
