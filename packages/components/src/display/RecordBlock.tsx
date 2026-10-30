import type { ReactNode } from 'react';

import { Pressable } from '../primitives/Pressable';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { FairyMark } from './FairyMark';
import { Icon } from './Icon';
import type { IconName } from './icons';

export type RecordBlockProps = {
  /** 「Fairy 在后台处理了 8 件事 · 10:02–11:39」。 */
  title: string;
  /** 标题后面的淡字，例如按来源计数「Slack 5 · GitHub 2」。 */
  meta?: string | null;
  /** 右边的文字按钮：「展开」「收起」。 */
  toggle?: { expanded: boolean; onPress: () => void };
  children?: ReactNode;
  testID?: string;
};

// 模式「记录块」（patterns P9.8，主题 11.8）：Fairy 没对你说、自己处理掉的事。像页边的批注：
// 左边一条 1px 的竖线，竖线顶上是安静版的 Fairy 标记，没有底色，没有外框。头部一行 meta 600，下面一行一件事（RecordLine）。
export function RecordBlock({ title, meta, toggle, children, testID }: RecordBlockProps) {
  return (
    <Row testID={testID} w="100%" gap="inline-item">
      <Column items="center" shrink={0} self="stretch">
        <FairyMark quiet size={14} />
        <Box flex={1} w={1} bg="border" />
      </Column>
      <Column flex={1} minW={0} gap="list-row">
        <Row items="center" gap="inline-item" minH={18}> {/* 和 Fairy 标记一样高（组件规格） */}
          <Text shrink={1} size="meta" weight="semibold" tone="secondary" numberOfLines={1}>{title}</Text>
          {meta ? <Text flex={1} minW={0} size="meta" tone="muted" numberOfLines={1}>{meta}</Text> : <Box flex={1} />}
          {toggle ? (
            // 浮层的背景也叫「收起」：这个按钮说清收起的是记录。
            <Pressable onPress={toggle.onPress} feedback="none" aria-label={toggle.expanded ? '收起记录' : '展开'} aria-expanded={toggle.expanded}>
              <Row items="center" gap="text-stack">
                <Text size="meta" weight="semibold" tone="strong">{toggle.expanded ? '收起' : '展开'}</Text>
                <Icon name={toggle.expanded ? 'chevron-up' : 'chevron-down'} size={11} color="text" weight="semibold" />
              </Row>
            </Pressable>
          ) : null}
        </Row>
        {children}
      </Column>
    </Row>
  );
}

export type RecordTagProps = {
  /** 来源：「Slack」「GitHub」。写在处置前面，用「 · 」隔开。 */
  source?: string | null;
  label: string;
  labelTestID?: string;
  icon?: IconName;
  /** warning：「延后」用 warning-soft 底；done：已在别处处理，白底细边框加一个勾。 */
  tone?: 'neutral' | 'warning' | 'done';
};

// 记录块一行里的标签：写来源和处置（surface-muted 底，圆角 6；「延后」是 warning-soft 底）。
export function RecordTag({ source, label, labelTestID, icon, tone = 'neutral' }: RecordTagProps) {
  return (
    <Row
      testID="record-tag"
      shrink={0}
      items="center"
      gap="text-stack"
      px="pill-x"
      rounded="xs"
      bg={tone === 'warning' ? 'warning-soft' : tone === 'done' ? 'surface' : 'surface-muted'}
      borderWidth={tone === 'done' ? 1 : 0}
      borderColor="border"
    >
      {tone === 'done' ? <Icon name="check" size={10} color="text-muted" weight="semibold" /> : icon ? <Icon name={icon} size={10} color="text-secondary" weight="semibold" /> : null}
      {source ? <Text size="eyebrow" weight="semibold" tone={tone === 'warning' ? 'warning-dark' : tone === 'done' ? 'muted' : 'secondary'}>{`${source} · `}</Text> : null}
      <Text testID={labelTestID} size="eyebrow" weight="semibold" tone={tone === 'warning' ? 'warning-dark' : tone === 'done' ? 'muted' : 'secondary'}>{label}</Text>
    </Row>
  );
}

export type RecordLineProps = {
  /** 等宽字的时间「11:39」。 */
  time: string;
  tag: ReactNode;
  /** 摘要：message-body、text-strong。结束了的行变淡。 */
  text: string;
  ended?: boolean;
  /** 行尾：件数、工单链接。 */
  trailing?: ReactNode;
  /** 展开以后挂在这一行下面的：理由、依据。有它时这一行是一块浅灰底（主题 11.8 状态 3）。 */
  detail?: ReactNode;
  /** 收起时摘要只占一行。 */
  lines?: number;
  /** 浮层里的行：没有细节的行也留出和有细节的行一样的内边距，几行的时间对齐成一列。 */
  inset?: boolean;
  onPress?: () => void;
  testID?: string;
};

// 记录块里的一行：等宽时间、标签、摘要、行尾。
export function RecordLine({ time, tag, text, ended = false, trailing, detail, lines = 1, inset = false, onPress, testID }: RecordLineProps) {
  return (
    <Pressable testID={testID} onPress={onPress} feedback={onPress ? 'highlight' : 'none'} rounded="md"
      {...(detail || inset ? { px: 'inset-x' as const, py: 'inset-y' as const } : {})}
      {...(detail ? { bg: 'surface-muted' as const } : {})}>
      {/* 时间、标签和摘要的第一行按文字基线对齐：三者字号不同，按顶部对齐时小字会浮在上面。 */}
      <Row items="baseline" gap="inline-item">
        <Text size="meta" mono tone="secondary" shrink={0}>{time}</Text>
        {tag}
        <Column flex={1} minW={0} gap="text-stack">
          <Row items="baseline" gap="inline-item">
            <Text flex={1} minW={0} size="message-body" tone={ended ? 'muted' : 'strong'} numberOfLines={lines}>
              {ended ? text : emphasizeNumbers(text).map((part, index) => (part.number
                ? <Text key={index} size="message-body" weight="semibold" tone="default">{part.text}</Text>
                : part.text))}
            </Text>
            {trailing}
          </Row>
          {detail}
        </Column>
      </Row>
    </Pressable>
  );
}

// 摘要里的数字加粗（主题 11.8「关键数字加粗成 text」）：「还剩 11 条未确认」「4 项检查全绿」。
// 编号（#118）和时刻（18:00）不算：它们是名字，不是数量。这只是排版，不判断文字的意思。
const NUMBER = /(?<![#\d:.])\d[\d,]*(?:\.\d+)?%?(?![\d:])/gu;

export function emphasizeNumbers(text: string): Array<{ text: string; number: boolean }> {
  const parts: Array<{ text: string; number: boolean }> = [];
  let last = 0;
  for (const match of text.matchAll(NUMBER)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start), number: false });
    parts.push({ text: match[0], number: true });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), number: false });
  return parts;
}
