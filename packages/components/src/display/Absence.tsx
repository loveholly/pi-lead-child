import { useState, type ReactNode } from 'react';

import { Button } from '../controls/Button';
import { Pressable } from '../primitives/Pressable';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { AnchoredPanel } from './AnchoredPanel';
import { Icon } from './Icon';
import type { IconName } from './icons';

export type AbsenceDetail = {
  label: string;
  /** 一段文字，或者文字加一个按钮（「换个模型重发」）。 */
  value: ReactNode;
  /** 原文（报错、日志）用等宽字。 */
  mono?: boolean;
};

export type AbsenceAction = { label: string; onPress: () => void; icon?: IconName };

export type AbsenceProps = {
  /** danger：没有回答、没发出去；warning：在等、在重试。 */
  tone?: 'danger' | 'warning';
  /** 600 的一个短词：「没有回答」。 */
  label: string;
  /** 跟在后面的一句，通常引用你那句话：「你问的「#104 那个 PR 现在还要吗？」」。 */
  text?: string | null;
  /** 右边的按钮，例如「重发」。 */
  actions?: readonly AbsenceAction[];
  /** 点开以后一行一项：做过、原因、原文。没有时这一行不能点开。 */
  details?: readonly AbsenceDetail[];
  testID?: string;
};

// 模式「缺席占位」（patterns P9.7，主题 11.7）：本该有一轮回复的地方只剩一条虚线轮廓，和一行字一样高。
// 一行：失败图标、600 的短词、引用你那句话，右边是「重发」和展开箭头。没有底色。
// 点开从原位置撑开成浮层（会话列表不跳），一行一项写做过的事、原因、原文。
// 虚线框的边框宽度、圆角、高度是组件规格。
export function Absence({ tone = 'danger', label, text, actions = [], details = [], testID }: AbsenceProps) {
  const [open, setOpen] = useState(false);
  const expandable = details.length > 0;
  const row = (expanded: boolean) => (
    <AbsenceRow tone={tone} label={label} text={text} actions={actions} expandable={expandable} expanded={expanded}
      onToggle={() => setOpen(!expanded)} testID={testID} />
  );
  if (!expandable) return <AbsenceFrame tone={tone} testID={testID}>{row(false)}</AbsenceFrame>;
  return (
    <AnchoredPanel
      testID={testID ? `${testID}-anchor` : undefined}
      open={open}
      onClose={() => setOpen(false)}
      label={text ? `${label} · ${text}` : label}
      header={row(true)}
      body={(
        <Column testID={testID ? `${testID}-details` : undefined} px="card" py="card-row" gap="text-stack">
          {details.map((detail) => (
            <Row key={detail.label} items="flex-start" gap="inline-item">
              {/* 标签列的宽度是组件规格：两个字加一点留白，值对齐成一列。 */}
              <Box w={44} shrink={0}><Text size="secondary" tone="secondary">{detail.label}</Text></Box>
              {typeof detail.value === 'string' ? (
                <Text flex={1} minW={0} size={detail.mono ? 'code' : 'secondary'} mono={detail.mono} tone={detail.mono ? 'secondary' : 'default'}>{detail.value}</Text>
              ) : <Box flex={1} minW={0}>{detail.value}</Box>}
            </Row>
          ))}
        </Column>
      )}
    >
      <AbsenceFrame tone={tone} testID={testID}>{row(false)}</AbsenceFrame>
    </AnchoredPanel>
  );
}

function AbsenceFrame({ tone, testID, children }: { tone: 'danger' | 'warning'; testID?: string; children: React.ReactNode }) {
  return (
    <Box
      testID={testID}
      w="100%"
      rounded="xl"
      borderWidth={1.5} // 缺席占位的虚线框（组件规格，主题 11.7）
      borderStyle="dashed"
      borderColor={tone === 'danger' ? 'danger-line' : 'warning-border'}
    >
      {children}
    </Box>
  );
}

function AbsenceRow({ tone, label, text, actions, expandable, expanded, onToggle, testID }: {
  tone: 'danger' | 'warning'; label: string; text?: string | null; actions: readonly AbsenceAction[];
  expandable: boolean; expanded: boolean; onToggle: () => void; testID?: string;
}) {
  const words = (
    <Row flex={1} minW={0} items="center" gap="icon-label">
      <Icon name="no-reply" size={14} color={tone === 'danger' ? 'danger-dark' : 'warning-dark'} />
      <Text flex={1} minW={0} size="secondary" numberOfLines={expanded ? 2 : 1}>
        <Text size="secondary" weight="semibold">{label}</Text>
        {text ? <Text size="secondary" tone="strong">{` · ${text}`}</Text> : null}
      </Text>
    </Row>
  );
  return (
    <Row minH={38} items="center" gap="inline-item" px="banner-x"> {/* 和一行字一样高：40 减去上下两道 1.5 的虚线（组件规格） */}
      {expandable ? (
        <Pressable flex={1} minW={0} aria-label={`${label}，${expanded ? '收起' : '展开'}`} aria-expanded={expanded} onPress={onToggle} feedback="none"
          testID={testID ? `${testID}-${expanded ? 'collapse' : 'expand'}` : undefined}>
          {words}
        </Pressable>
      ) : words}
      {actions.map((action) => (
        <Button key={action.label} label={action.label} onPress={action.onPress} {...(action.icon ? { icon: action.icon } : {})} variant="ghost" tone="neutral" size="xs" />
      ))}
      {expandable ? (
        <Pressable aria-hidden onPress={onToggle} feedback="none" shrink={0}>
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={12} color="text-secondary" weight="semibold" />
        </Pressable>
      ) : null}
    </Row>
  );
}

export type AbsenceTailProps = {
  /** 为什么停了：「daemon 重启，没说完」。 */
  text: string;
  actions?: readonly AbsenceAction[];
  testID?: string;
};

// 缺席占位的接尾（主题 11.7）：回复说到一半被打断，已经说出的文字留着，后面接一个小的琥珀虚线胶囊，写原因和「重发」。
export function AbsenceTail({ text, actions = [], testID }: AbsenceTailProps) {
  return (
    <Row
      testID={testID}
      self="flex-start"
      maxW="100%"
      items="center"
      gap="icon-label"
      rounded="full"
      px="inset-x"
      minH={26} // 胶囊的高度（组件规格）
      borderWidth={1.5} // 和缺席占位同一种虚线（组件规格）
      borderStyle="dashed"
      borderColor="warning-border"
    >
      <Icon name="interrupted" size={12} color="warning-dark" />
      <Text shrink={1} size="meta" tone="secondary" numberOfLines={1}>{text}</Text>
      {actions.map((action) => (
        <Button key={action.label} label={action.label} onPress={action.onPress} variant="link" tone="neutral" size="xs" />
      ))}
    </Row>
  );
}
