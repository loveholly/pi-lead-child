import { useState, type ReactNode } from 'react';

import { Button } from '../controls/Button';
import { Pressable } from '../primitives/Pressable';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { AnchoredPanel } from './AnchoredPanel';
import { Icon } from './Icon';
import type { IconName } from './icons';

export type SystemLineProps = {
  /** 600 的开头：「心跳巡检没有完成」。 */
  lead?: string | null;
  /** 后面的说明：「连续 3 次 · 最近 11:51 · 12:10 自动再试」。 */
  text?: string | null;
  icon?: IconName;
  /** danger：图标用红色（别的凭证做的操作，C-16）。 */
  iconTone?: 'secondary' | 'danger';
  /** 连续失败：前面放三个叠在一起的小圆点，颜色从深到浅。 */
  repeated?: boolean;
  /** 行尾的一个文字按钮（「不是我」）。系统信息行通常不给按钮，只有要你认领的事才给。 */
  action?: { label: string; onPress: () => void; tone?: 'neutral' | 'danger'; testID?: string };
  /** 划掉的开头（已撤销的那件事）。 */
  struck?: boolean;
  /** 开头和说明之间的连接。缺省是「 · 」；接成一句话时用空格（「CLI 凭证 #31 在 03:12 批准了…」）。 */
  separator?: string;
  /** 时间「10:46」：写在说明后面，说明太长被截断时它也不会被挤走。 */
  time?: string | null;
  /** 点开以后看的原文（报错、写给 Lead 的说明），或者一组明细（GroupList）。有它时行尾一个展开箭头，点开从原位置撑开成浮层。 */
  details?: ReactNode;
  testID?: string;
};

// 模式「系统信息行」（patterns P9.9，主题 11.9）：左对齐的一行小字，系统自己会处理、不用你做什么的事。
// 永远只占一行（2026-10-28 用户：居中换行太难看，改成左对齐）：说明太长时在末尾截断，时间跟在后面不被挤走，全文放进 details。
// 通常不给按钮；别的凭证做的操作行尾有「不是我」，只有图标和这个按钮是红色（主题 11.6、C-16）。
// 有原文时行尾一个展开箭头：点开从原位置撑开成浮层（会话列表不跳），浮层里是同一行加上原文。
export function SystemLine(props: SystemLineProps) {
  const [open, setOpen] = useState(false);
  if (!props.details) return <SystemLineRow {...props} />;
  const toggle = { open, onPress: () => setOpen(!open) };
  return (
    <AnchoredPanel
      open={open}
      onClose={() => setOpen(false)}
      label={[props.lead, props.text].filter(Boolean).join(' · ') || '系统信息'}
      header={<Box py="card-row"><SystemLineRow {...props} testID={props.testID ? `${props.testID}-open` : undefined} toggle={{ ...toggle, open: true }} /></Box>}
      body={(
        <Column testID={props.testID ? `${props.testID}-details` : undefined} px="card" py="card-row">
          {typeof props.details === 'string' ? <Text size="code" mono tone="secondary">{props.details}</Text> : props.details}
        </Column>
      )}
    >
      <SystemLineRow {...props} toggle={toggle} />
    </AnchoredPanel>
  );
}

function SystemLineRow({ lead, text, time, icon, iconTone = 'secondary', repeated = false, action, struck = false, separator = ' · ', testID, toggle }: SystemLineProps & {
  toggle?: { open: boolean; onPress: () => void };
}) {
  return (
    <Row testID={testID} w="100%" items="center" gap="icon-label" minW={0}>
      {/* 图标占 FairyMark 那么宽：和记录块的 Fairy 标记对齐在同一条竖线上（组件规格）。 */}
      <Box w={18} shrink={0} items="center">
        {repeated ? <RepeatDots /> : icon ? <Icon name={icon} size={12} color={iconTone === 'danger' ? 'danger-dark' : 'text-secondary'} /> : null}
      </Box>
      <Text testID={testID ? `${testID}-text` : undefined} shrink={1} minW={0} size="meta" tone="secondary" numberOfLines={1}>
        {lead ? (
          <Text size="meta" weight="semibold" tone={struck ? 'muted' : 'strong'} {...(struck ? { textDecorationLine: 'line-through' as const } : {})}>{lead}</Text>
        ) : null}
        {lead && text ? separator : null}
        {text ?? null}
      </Text>
      {time ? <Text testID={testID ? `${testID}-time` : undefined} size="meta" tone="secondary" shrink={0}>{`· ${time}`}</Text> : null}
      {action ? (
        <Button testID={action.testID} label={action.label} onPress={action.onPress} variant="link" tone={action.tone ?? 'neutral'} size="xs" />
      ) : null}
      {toggle ? (
        <Pressable aria-label={toggle.open ? '收起原文' : '看原文'} aria-expanded={toggle.open} onPress={toggle.onPress} feedback="none" shrink={0}
          testID={testID ? `${testID}-${toggle.open ? 'collapse' : 'expand'}` : undefined}>
          <Icon name={toggle.open ? 'chevron-up' : 'chevron-down'} size={11} color="text-secondary" weight="semibold" />
        </Pressable>
      ) : null}
    </Row>
  );
}

// 三个叠在一起的小圆点，从深到浅：同一件事连着失败了几次。点的大小和重叠是组件规格。
function RepeatDots() {
  const shades = ['danger-dark', 'danger', 'danger-line'] as const;
  return (
    <Row aria-hidden shrink={0}>
      {shades.map((shade, index) => (
        <Box key={shade} w={7} h={7} rounded="full" bg={shade} ml={index === 0 ? 0 : -3} borderWidth={1} borderColor="surface" />
      ))}
    </Row>
  );
}
