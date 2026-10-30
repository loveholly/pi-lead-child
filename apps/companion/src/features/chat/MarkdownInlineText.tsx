import { Code, Link, safeLink, Text, type FontSizeToken, type TextProps } from '@pi-lead-child/components';

import type { MarkdownInline } from './markdownModel';

type MarkdownInlineTextProps = {
  inlines: MarkdownInline[];
  size: FontSizeToken;
  // 行高，单位是像素。不给就用字体默认的行高（会话正文，2026-10-21）。
  leading?: number;
  weight?: TextProps['weight'];
  tone?: TextProps['tone'];
};

// 一段 Markdown 行内内容放在同一个 Text 树里：加粗、斜体、删除线、行内代码和链接都是嵌套的 Text，
// 这样原生和 web 都按整段文字换行，链接也能点。GitHub 的样式（2026-10-16）：链接悬停时才有下划线；
// 行内代码小一号，是浅灰的小圆角块。

// 行内代码比正文小一号（GitHub 是 85%）。
const CODE_SIZE: Partial<Record<FontSizeToken, FontSizeToken>> = {
  '18': '16', '16': '14', '15': '13', '14': '12.5', '13': '12', '12.5': '11.5', '12': '11',
  'message-lead': '14', 'message-body': '12.5',
};
export function MarkdownInlineText({ inlines, size, leading, weight = 'regular', tone = 'default' }: MarkdownInlineTextProps) {
  return (
    <Text select="text" testID="markdown-inline-root" w="100%" shrink={1} size={size} leading={leading} weight={weight} tone={tone}>
      {inlines.map((inline, index) => {
        const key = `${index}-${inline.text}`;
        const href = safeLink(inline.href);
        const inlineWeight = inline.strong ? 'bold' : weight;
        if (href) {
          return (
            <Link key={key} href={href} underline="hover" testID="markdown-link" size={size} weight={inlineWeight} italic={inline.emphasis}>
              {inline.text}
            </Link>
          );
        }
        if (inline.code) {
          return <Code key={key} testID="markdown-inline-code" size={CODE_SIZE[size] ?? size}>{inline.text}</Code>;
        }
        return (
          <Text
            key={key}
            size={size}
            weight={inlineWeight}
            italic={inline.emphasis}
            tone={inline.strike ? 'secondary' : tone}
            textDecorationLine={inline.strike ? 'line-through' : 'none'}
          >
            {inline.text}
          </Text>
        );
      })}
    </Text>
  );
}
