import { useRef, useState, type ReactNode } from 'react';
import type { LayoutChangeEvent } from 'react-native';

import { IconButton } from '../controls/Button';
import { Box, Column, Row } from '../primitives/layout';
import { ScrollArea, type ScrollAreaHandle, type ScrollEvent } from '../primitives/ScrollArea';

export type DataTableProps = {
  header: ReactNode[];
  rows: ReactNode[][];
  /** 每一列的宽度（像素）。原生没有表格布局，各行要用同样的列宽才能对齐。 */
  columnWidths: number[];
  /** 每一列的对齐，和 Markdown 表格的 :--、:-:、--: 一样。 */
  align?: ReadonlyArray<'left' | 'center' | 'right' | null>;
  testID?: string;
};

const JUSTIFY = { left: 'flex-start', center: 'center', right: 'flex-end' } as const;
// 没写列宽的列按这个宽度画。
const DEFAULT_COLUMN_WIDTH = 120;
// 测量有 1px 的误差：差不到这么多时，算作已经到头。
const EDGE_SLACK = 1;
// 边缘的渐隐：从透明到白底，分几条画（原生没有渐变）。宽度合计 24。
const FADE_STEPS = [0.25, 0.5, 0.75, 0.92] as const;
const FADE_STEP_WIDTH = 6;

// 表格（2026-10-17，会话方案第四版的样式）：一张圆角卡片，表头浅灰底，行之间一条细线，
// 没有竖线和斑马纹；比可用宽度宽时在表格里横向滚动，不撑宽页面。
// 2026-10-26：能滚动还不够。macOS 平时不显示滚动条，最后一列看起来像被截断了。
// 所以有内容藏着的那一边画一道渐隐和一个箭头按钮（按一下滚过去大半个框宽），滚到头就去掉。
export function DataTable({ header, rows, columnWidths, align = [], testID }: DataTableProps) {
  const scroll = useRef<ScrollAreaHandle>(null);
  const [viewport, setViewport] = useState(0);
  const [offset, setOffset] = useState(0);
  const contentWidth = header.reduce<number>((sum, _, column) => sum + (columnWidths[column] ?? DEFAULT_COLUMN_WIDTH), 0) + 2;
  const overflow = viewport > 0 && contentWidth - viewport > EDGE_SLACK;
  const moreLeft = overflow && offset > EDGE_SLACK;
  const moreRight = overflow && offset + viewport < contentWidth - EDGE_SLACK;
  const page = (direction: 1 | -1) => {
    const target = Math.max(0, Math.min(contentWidth - viewport, offset + direction * Math.round(viewport * 0.8)));
    scroll.current?.scrollTo({ x: target, y: 0, animated: true });
  };
  const onLayout = (event: LayoutChangeEvent) => setViewport(event.nativeEvent.layout.width);
  const onScroll = (event: ScrollEvent) => {
    setOffset(event.nativeEvent.contentOffset.x);
    if (event.nativeEvent.layoutMeasurement.width > 0) setViewport(event.nativeEvent.layoutMeasurement.width);
  };

  const cell = (content: ReactNode, column: number, last: boolean) => (
    <Box
      key={column}
      w={columnWidths[column] ?? DEFAULT_COLUMN_WIDTH}
      px={column === 0 || last ? 14 : 10}
      py={9} // spacing-exempt: 表格单元格内边距
      justify="center"
      items={JUSTIFY[align[column] ?? 'left']}
    >
      {content}
    </Box>
  );
  return (
    <Box position="relative">
      <ScrollArea
        ref={scroll}
        testID={testID ? `${testID}-scroll` : undefined}
        horizontal
        flex={0}
        showsScrollIndicator
        onLayout={onLayout}
        onScroll={onScroll}
      >
        <Column testID={testID} borderWidth={1} borderColor="border" rounded="xl" overflow="hidden">
          <Row testID={testID ? `${testID}-header` : undefined} bg="surface-subtle">
            {header.map((content, column) => cell(content, column, column === header.length - 1))}
          </Row>
          {rows.map((row, index) => (
            <Row
              key={index}
              testID={testID ? `${testID}-row-${index}` : undefined}
              bg="surface"
              borderTopWidth={1}
              borderTopColor="border-soft"
            >
              {row.map((content, column) => cell(content, column, column === row.length - 1))}
            </Row>
          ))}
        </Column>
      </ScrollArea>
      {moreLeft ? <EdgeCue side="left" testID={testID} onPress={() => page(-1)} /> : null}
      {moreRight ? <EdgeCue side="right" testID={testID} onPress={() => page(1)} /> : null}
    </Box>
  );
}

// 一边的提示：渐隐盖在表格边上，不挡点击；箭头按钮在渐隐里竖直居中。
function EdgeCue({ side, testID, onPress }: { side: 'left' | 'right'; testID?: string; onPress: () => void }) {
  const steps = side === 'right' ? FADE_STEPS : [...FADE_STEPS].reverse();
  return (
    <Box
      testID={testID ? `${testID}-more-${side}` : undefined}
      position="absolute"
      t={1} // spacing-exempt: 让出表格的 1px 边框
      b={1} // spacing-exempt: 让出表格的 1px 边框
      {...(side === 'right' ? { r: 1 } : { l: 1 })} // spacing-exempt: 让出表格的 1px 边框
      justify="center"
      items="center"
      pointerEvents="box-none"
    >
      <Row position="absolute" t={0} b={0} l={0} r={0} pointerEvents="none">
        {steps.map((opacity, index) => (
          <Box key={index} w={FADE_STEP_WIDTH} bg="surface" opacity={opacity} />
        ))}
      </Row>
      <IconButton
        icon={side === 'right' ? 'chevron-right' : 'chevron-left'}
        label={side === 'right' ? '向右看更多列' : '向左看前面的列'}
        onPress={onPress}
        variant="outline"
        size="xs"
        rounded="full"
        testID={testID ? `${testID}-page-${side}` : undefined}
      />
    </Box>
  );
}
