import { ProgressBar } from '../display/ProgressBar';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { formatNumber, withUnit } from './format';
import { dataToneFill, type DataTone } from './tones';

export type BarChartBar = { label: string; value: number; tone?: DataTone };

export type BarChartProps = {
  bars: readonly BarChartBar[];
  unit?: string;
  /** horizontal：每根条形一行，名字和数值写在上面。vertical：竖向的柱子，适合按时间排的数。 */
  orientation?: 'horizontal' | 'vertical';
  /** 满格的值。不给时以最高那根为满格。 */
  max?: number;
  testID?: string;
};

// 竖向条形图的高度（不含下面的标签）。
const COLUMN_CHART_HEIGHT = 120;
// 竖向条形图的条形不多时，每根上面写数值、下面写标签；多了只写最大值，标签只写首尾。
const COLUMN_LABELS_LIMIT = 8;

// 条形图。每根条形都有无障碍名称「名字：数值」。
export function BarChart({ bars, unit, orientation = 'horizontal', max, testID }: BarChartProps) {
  const full = max ?? Math.max(...bars.map((bar) => bar.value));
  const ratio = (value: number) => (full > 0 ? Math.min(1, value / full) : 0);
  if (orientation === 'vertical') {
    return <ColumnChart testID={testID} bars={bars} unit={unit} scale={`${max === undefined ? '最高' : '满格'} ${withUnit(full, unit)}`} ratio={ratio} />;
  }
  return (
    <Column testID={testID} gap="stacked-card">
      {bars.map((bar, index) => (
        <Column key={index} gap="card-row" aria-label={`${bar.label}：${withUnit(bar.value, unit)}`} role="img">
          <Row items="baseline" gap="inline-item">
            <Text flex={1} minW={0} size="label" numberOfLines={1}>{bar.label}</Text>
            <Text size="meta" mono tone="secondary" shrink={0}>{withUnit(bar.value, unit)}</Text>
          </Row>
          <Row>
            <ProgressBar value={ratio(bar.value) * 100} color={dataToneFill(bar.tone)} track="surface-muted" height={8} />
          </Row>
        </Column>
      ))}
    </Column>
  );
}

// scale 说明刻度：给了 max 时是「满格 …」，没给时是最高那根的值「最高 …」。
function ColumnChart({ testID, bars, unit, scale, ratio }: {
  testID?: string; bars: readonly BarChartBar[]; unit?: string; scale: string; ratio: (value: number) => number;
}) {
  const labelled = bars.length <= COLUMN_LABELS_LIMIT;
  const area = labelled ? COLUMN_CHART_HEIGHT - 18 : COLUMN_CHART_HEIGHT;
  const gap = bars.length > 12 ? 3 : 8;
  return (
    <Column testID={testID} gap="card-row">
      {labelled ? null : <Text size="note" tone="secondary">{scale}</Text>}
      <Row h={COLUMN_CHART_HEIGHT} items="flex-end" gap={gap} borderBottomWidth={1} borderBottomColor="border">
        {bars.map((bar, index) => (
          <Column
            key={index}
            flex={1}
            minW={0}
            h={COLUMN_CHART_HEIGHT}
            justify="flex-end"
            items="center"
            gap="text-stack"
            aria-label={`${bar.label}：${withUnit(bar.value, unit)}`}
            role="img"
          >
            {labelled ? <Text size="meta" mono tone="secondary" numberOfLines={1}>{formatNumber(bar.value)}</Text> : null}
            <Box
              w="100%"
              maxW={40}
              h={bar.value > 0 ? Math.max(2, Math.round(ratio(bar.value) * area)) : 0}
              borderTopLeftRadius={3}
              borderTopRightRadius={3}
              bg={dataToneFill(bar.tone)}
            />
          </Column>
        ))}
      </Row>
      {labelled ? (
        <Row gap={gap}>
          {bars.map((bar, index) => (
            <Box key={index} flex={1} minW={0} items="center">
              <Text size="label" tone="secondary" numberOfLines={1}>{bar.label}</Text>
            </Box>
          ))}
        </Row>
      ) : (
        <Row justify="space-between" gap="inline-item">
          <Text size="label" tone="secondary" numberOfLines={1}>{bars[0]!.label}</Text>
          <Text size="label" tone="secondary" numberOfLines={1}>{bars[bars.length - 1]!.label}</Text>
        </Row>
      )}
      {labelled && unit ? <Text size="note" tone="secondary">{`单位：${unit}`}</Text> : null}
    </Column>
  );
}
