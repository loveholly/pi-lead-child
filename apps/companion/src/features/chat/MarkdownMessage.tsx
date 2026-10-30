import {
  Box, CodeBlock, Column, DataTable, Row, TaskCheckbox, Text, estimatedTextWidth, isNumericColumn, tableColumnWidth,
  type FontSizeToken, type TextProps,
} from '@pi-lead-child/components';
import { createContext, useContext, useMemo } from 'react';

import { MarkdownInlineText } from './MarkdownInlineText';
import { parseMarkdownMessage, type MarkdownBlock, type MarkdownInline } from './markdownModel';

// 把 Lead 的 Markdown 回复渲染成组件库的文字和块。解析见 markdownModel.ts。主会话和工单对话都用它。
// 宽度跟着所在的内容列（会话里是 ConversationColumn，2026-10-16）：正文和卡片一样宽，不再单独限在 prose。
// 样式用会话方案第四版的消息样式（2026-10-17 用户要求，原来的样式太素）：
//   · 正文用语义字号 message-body（14，2026-10-21 用户要求，原来是 15）。正文、结论句和标题不设行高，
//     用字体默认的行高（2026-10-21 用户要求，原来是 26）；
//   · 间距用语义间距（theme/tokens 的 spacing）：一条回复里块和块之间 reply-block（原来是 12），
//     列表项之间、列表项和引用里面的块之间 list-row；
//   · 结论先行：第一段整段加粗时，是这条回复的结论，语义字号 message-lead、加粗；
//   · 标题只加粗、加大，下面不画线；
//   · 表格是一张圆角卡片：表头浅灰底，行之间一条细线，没有竖线和斑马纹；全是数字的列右对齐、等宽字体；
//   · 代码块浅灰底、细边、圆角，右上角是复制按钮；行内代码是浅灰的小圆角块；分隔线是一条细线。
// 卡片里来自 Lead 或 child 的自由文本（介入卡的回答、说明）也用它（2026-10-26）：传卡片正文的 size 和 tone，
// 结论句只加粗、不加大。
export function MarkdownMessage({ markdown, size = 'message-body', tone = 'default', breaks = false }: {
  markdown: string;
  /** 段落里的单个换行当真的换行。外部来源（Slack）的原文用，Lead 的回复不用。 */
  breaks?: boolean;
  /** 正文的语义字号。会话回复是 message-body，卡片里用卡片正文的字号。 */
  size?: FontSizeToken;
  tone?: Tone;
}) {
  const blocks = useMemo(() => parseMarkdownMessage(markdown, { breaks }), [breaks, markdown]);

  return (
    <BodySize.Provider value={size}>
      <Box testID="markdown-message" w="100%">
        <MarkdownBlocks blocks={blocks} top tone={tone} />
      </Box>
    </BodySize.Provider>
  );
}

type Tone = TextProps['tone'];

const BodySize = createContext<FontSizeToken>('message-body');

function MarkdownBlocks({ blocks, nested = false, top = false, depth = 0, tone = 'default' }: {
  blocks: MarkdownBlock[];
  nested?: boolean;
  /** 整条回复的最外层：只有这一层的第一段可能是结论句。 */
  top?: boolean;
  /** 列表的层级：决定圆点的样子。 */
  depth?: number;
  tone?: Tone;
}) {
  return (
    <Column w="100%" gap={nested ? 'list-row' : 'reply-block'}>
      {blocks.map((block, index) => (
        <MarkdownBlockView
          key={`${block.kind}-${index}`}
          block={block}
          first={index === 0}
          lead={top && index === 0 && isLeadSentence(block)}
          depth={depth}
          tone={tone}
        />
      ))}
    </Column>
  );
}

/** 第一段整段加粗（空白不算）：Lead 先给的结论。 */
export function isLeadSentence(block: MarkdownBlock): boolean {
  if (block.kind !== 'paragraph') return false;
  const visible = block.inlines.filter((inline) => inline.text.trim().length > 0);
  return visible.length > 0 && visible.every((inline) => inline.strong && !inline.code && !inline.href);
}

const HEADING = {
  1: { size: '18' },
  2: { size: '16' },
  3: { size: '15' },
  4: { size: '15' },
  5: { size: '14' },
  6: { size: '14' },
} as const;

const BULLETS = ['•', '◦', '▪'];

function MarkdownBlockView({ block, first, lead, depth, tone }: { block: MarkdownBlock; first: boolean; lead: boolean; depth: number; tone: Tone }) {
  const body = useContext(BodySize);
  if (block.kind === 'heading') {
    const style = HEADING[Math.min(Math.max(block.depth, 1), 6) as keyof typeof HEADING];
    return (
      <Box testID={`markdown-heading-${block.depth}`} mt={first ? 0 : 6}>
        <MarkdownInlineText
          inlines={block.inlines}
          size={style.size}
          weight="bold"
          tone={block.depth === 6 ? 'secondary' : tone}
        />
      </Box>
    );
  }
  if (block.kind === 'list') {
    return (
      <Column testID="markdown-list" gap="list-row">
        {block.items.map((item, itemIndex) => {
          const task = item.checked !== null;
          return (
            <Row key={`item-${itemIndex}`} items="flex-start" gap={task ? 8 : 6}>
              {task ? (
                // 勾选框在一行正文那么高的一行里居中。正文的行高来自语义字号（24），这一行的高度跟着它走，
                // 换字号、换行高都不用重新调偏移（2026-10-21，原来是按行高 26 调的 pt=5）。
                <Row items="center" shrink={0}>
                  <Text size={body} aria-hidden>{'​'}</Text>
                  <TaskCheckbox checked={item.checked === true} />
                </Row>
              ) : (
                <Box w={block.ordered ? 22 : 16} items={block.ordered ? 'flex-end' : 'center'} shrink={0}>
                  <Text size={body} tone="secondary">
                    {block.ordered ? `${block.start + itemIndex}.` : BULLETS[depth % BULLETS.length]}
                  </Text>
                </Box>
              )}
              <Box flex={1} minW={0}>
                <MarkdownBlocks blocks={item.blocks} nested depth={depth + 1} tone={tone} />
              </Box>
            </Row>
          );
        })}
      </Column>
    );
  }
  if (block.kind === 'quote') {
    return (
      // spacing-exempt: 引用竖线到文字的距离
      <Box testID="markdown-quote" pl={12} borderLeftWidth={3} borderLeftColor="border-strong">
        <MarkdownBlocks blocks={block.blocks} nested depth={depth} tone="secondary" />
      </Box>
    );
  }
  if (block.kind === 'code') return <CodeBlock testID="markdown-code" language={block.language} code={block.text} />;
  if (block.kind === 'table') {
    const numeric = numericColumns(block.rows);
    const align = block.header.map((_, column) => block.align[column] ?? (numeric[column] ? 'right' : null));
    return (
      <DataTable
        testID="markdown-table"
        align={align}
        columnWidths={columnWidths(block.header, block.rows)}
        header={block.header.map((cell, index) => (
          <MarkdownInlineText key={index} inlines={cell} size="13" leading={20} weight="semibold" tone="strong" /> // spacing-exempt: 表格单元格字号行高
        ))}
        rows={block.rows.map((row) => row.map((cell, index) => (
          numeric[index]
            ? <Text key={index} testID="markdown-table-number" mono size="body" tone={tone}>{cellText(cell)}</Text>
            : <MarkdownInlineText key={index} inlines={cell} size="13" leading={20} tone={tone} /> // spacing-exempt: 表格单元格字号行高
        )))}
      />
    );
  }
  if (block.kind === 'rule') return <Box testID="markdown-rule" h={1} my={6} bg="border-soft" />; // spacing-exempt: 分隔线上下间距
  if (lead) {
    return (
      <Box testID="markdown-lead">
        <MarkdownInlineText inlines={block.inlines} size={body === 'message-body' ? 'message-lead' : body} weight="bold" tone={tone} />
      </Box>
    );
  }
  return <MarkdownInlineText inlines={block.inlines} size={body} tone={tone} />;
}

function cellText(cell: MarkdownInline[] | undefined): string {
  return (cell ?? []).map((inline) => inline.text).join('');
}

// 一列的正文全是数字（可以带单位、正负号、百分号；空格子和「—」这类占位不算）：右对齐、等宽，
// 像第四版里 trace 的表格。
// 列宽按每一列最长的内容估（原生没有表格布局）。这两条规则在 packages/components 的 tableLayout.ts 里，
// Lead 用 render_ui 画的表格（genui 的 DataTable）也用它们，两种表格看起来一样。
export function numericColumns(rows: MarkdownInline[][][]): boolean[] {
  const width = Math.max(0, ...rows.map((row) => row.length));
  return Array.from({ length: width }, (_, column) => isNumericColumn(rows.map((row) => cellText(row[column]))));
}

function columnWidths(header: MarkdownInline[][], rows: MarkdownInline[][][]): number[] {
  const width = (cell: MarkdownInline[] | undefined) => estimatedTextWidth(cellText(cell));
  return header.map((cell, column) => tableColumnWidth(Math.max(width(cell), ...rows.map((row) => width(row[column])))));
}
