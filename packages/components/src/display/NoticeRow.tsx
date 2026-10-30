import { useState } from 'react';

import { Button } from '../controls/Button';
import { Pressable } from '../primitives/Pressable';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { Icon } from './Icon';

export type NoticeTone = 'danger' | 'warning';

export type NoticeRowProps = {
  tone: NoticeTone;
  /** 一句白话：发生了什么、系统在做什么、你能做什么。 */
  title: string;
  /** 跟在下面的小字，例如「共 2 次 · 最近 20:06」。 */
  meta?: string | null;
  /** 你能做的事，例如「重发」「打开工单 #51」。收起时也在。 */
  actions?: ReadonlyArray<{ label: string; onPress: () => void }>;
  /** 展开以后才显示的详情（原文、键值）。没有时这一行不能展开。 */
  details?: string | null;
  defaultExpanded?: boolean;
  testID?: string;
};

// 会话里的警告和失败：一行可以展开的条目（2026-10-16，和「Lead 动态」一样右边有箭头）。
// 收起时一两行：图标和一句话；下面是次数、时间和能做的事。展开以后显示详情。
// 白底、细描边，严重程度只用左边 3px 的色条和图标表示，不铺浅红、浅黄的底：在那上面红字和蓝色按钮都到不了 WCAG AA。
export function NoticeRow({ tone, title, meta, actions = [], details, defaultExpanded = false, testID }: NoticeRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const expandable = Boolean(details);
  const head = (
    <Row items="flex-start" gap="icon-label">
      {/* spacing-exempt: 光学对齐 */}
      <Box pt={2} shrink={0}>
        <Icon name={tone === 'danger' ? 'error' : 'warning'} size={14} color={tone} />
      </Box>
      <Text flex={1} minW={0} size="body" numberOfLines={expanded ? undefined : 2}>{title}</Text>
      {expandable ? (
        // spacing-exempt: 光学对齐
        <Box pt={3} shrink={0}>
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={12} color="text-secondary" weight="semibold" />
        </Box>
      ) : null}
    </Row>
  );
  return (
    <Column
      testID={testID}
      w="100%"
      bg="surface"
      borderWidth={1}
      borderColor="border-soft"
      borderLeftWidth={3}
      borderLeftColor={tone}
      rounded="md"
      overflow="hidden"
    >
      {expandable ? (
        <Pressable
          aria-label={`${title}，${expanded ? '收起详情' : '展开详情'}`}
          aria-expanded={expanded}
          onPress={() => setExpanded((value) => !value)}
          feedback="highlight"
          px="banner-x"
          pt="banner-y"
          pb={meta || actions.length ? 3 : 8}
        >
          {head}
        </Pressable>
      ) : (
        <Box px="banner-x" pt="banner-y" pb={meta || actions.length ? 3 : 8}>{head}</Box>
      )}
      {meta || actions.length ? (
        // spacing-exempt: 缩进到图标之后
        <Row items="center" gap="inline-item" flexWrap="wrap" pl={33} pr="banner-x" pb="banner-y" minH={26}>
          {meta ? <Text size="meta" tone="secondary">{meta}</Text> : null}
          {actions.map((action) => (
            <Button key={action.label} label={action.label} onPress={action.onPress} variant="link" size="xs" />
          ))}
        </Row>
      ) : null}
      {expanded && details ? (
        <Box mx="card-section" mb="card-section" px="inset-x" py="inset-y" rounded="sm" bg="surface-subtle">
          <Text size="code" mono tone="secondary">{details}</Text>
        </Box>
      ) : null}
    </Column>
  );
}
