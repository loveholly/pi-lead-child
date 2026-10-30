import type { ReactNode } from 'react';

import { IconButton } from '../controls/Button';
import { Badge, type BadgeTone } from '../display/Badge';
import { Icon } from '../display/Icon';
import type { IconName } from '../display/icons';
import { Pressable } from '../primitives/Pressable';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';

// 一条记录：子工单、运行记录、改动的文件（第四轮画板）。
// 没有在 ListItem 上扩展：ListItem 在 iOS 和 Android 上是原生列表行（Expo UI），标题只能是一段固定字体的文字，
// 只能放在原生 List 里；这里的主行有编号、粗体标题和次要文字，行要放在 Tamagui 的卡片里。三个平台都由 Tamagui 渲染。
export type RecordRowProps = {
  title: string;
  /** 主行最前面的编号，等宽，例如 #118。 */
  id?: string;
  /** 给了时编号占固定宽度，副行和标题对齐（子工单列表）。不给时编号紧跟标题。 */
  idWidth?: number;
  /** 跟在标题后面的次要文字，例如「· Claude Code · sonnet」或文件所在的目录。 */
  meta?: string;
  metaMono?: boolean;
  /** 副行。字符串按次要文字显示一行，超出用省略号。 */
  detail?: ReactNode;
  detailMono?: boolean;
  /** 主行右边的状态标签。 */
  badge?: { label: string; tone?: BadgeTone };
  /** 最前面的元素，例如目录的展开箭头。 */
  leading?: ReactNode;
  /** 右边、垂直居中的其他内容，例如「新增」「+78」。 */
  trailing?: ReactNode;
  /** 点整行。给了以后行尾显示 pressIcon。 */
  onPress?: () => void;
  /** 整行可点时行尾的图标：chevron-right 是在别处看详情，arrow-up-right 是用别的程序打开。 */
  pressIcon?: Extract<IconName, 'chevron-right' | 'arrow-up-right'>;
  /** 整行的无障碍名称，例如「在中间栏看 #118 的记录」。不给时用标题。 */
  accessibilityLabel?: string;
  /** 行尾单独的动作按钮。行本身也能点时，它们做的是两件事。disabled 时画成不能点。 */
  action?: { icon: IconName; label: string; onPress: () => void; disabled?: boolean };
  /** 上面画一条分隔线。列表里除第一行以外都画。 */
  divider?: boolean;
  testID?: string;
};

export function RecordRow({
  title, id, idWidth, meta, metaMono = false, detail, detailMono = false, badge, leading, trailing, onPress,
  pressIcon = 'chevron-right', accessibilityLabel, action, divider = false, testID,
}: RecordRowProps) {
  const content = (
    <>
      {leading ? <Box shrink={0}>{leading}</Box> : null}
      <Column flex={1} minW={0} gap="text-stack">
        <Row items="center" gap={idWidth ? 8 : 6} minW={0}>
          {id ? (
            <Text w={idWidth} shrink={0} size={idWidth ? '12' : '12.5'} mono weight={idWidth ? 'medium' : 'bold'} tone={idWidth ? 'secondary' : 'default'}>
              {id}
            </Text>
          ) : null}
          <Text flex={meta ? undefined : 1} shrink={1} minW={0} size="card-title" weight="bold" numberOfLines={1}>{title}</Text>
          {meta ? (
            <Text flex={1} minW={0} size={metaMono ? '11' : '12.5'} mono={metaMono} tone={metaMono ? 'secondary' : 'strong'} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
          {badge ? <Badge label={badge.label} tone={badge.tone} size="xs" /> : null}
        </Row>
        {typeof detail === 'string' ? (
          <Text
            pl={idWidth ? idWidth + 8 : 0}
            size={detailMono ? '11.5' : '12'}
            leading={detailMono ? 17 : 18}
            mono={detailMono}
            tone={detailMono ? 'secondary' : 'strong'}
            numberOfLines={1}
          >
            {detail}
          </Text>
        ) : detail ? <Box pl={idWidth ? idWidth + 8 : 0}>{detail}</Box> : null}
      </Column>
      {trailing ? <Row shrink={0} items="center" gap="inline-item">{trailing}</Row> : null}
      {onPress && !action ? <Icon name={pressIcon} size={12} color="text-secondary" weight="semibold" /> : null}
    </>
  );
  const frame = {
    testID,
    flexDirection: 'row',
    items: 'center',
    gap: 10,
    px: 14,
    py: 9,
    borderTopWidth: divider ? 1 : 0,
    borderTopColor: 'border-soft',
  } as const;
  if (action) {
    return (
      <Row {...frame}>
        {onPress ? (
          <Pressable flex={1} minW={0} flexDirection="row" items="center" gap="side-item" aria-label={accessibilityLabel ?? title} onPress={onPress} feedback="opacity">
            {content}
          </Pressable>
        ) : content}
        <IconButton icon={action.icon} label={action.label} onPress={action.onPress} disabled={action.disabled} variant="ghost" size="xs" iconSize={13} testID={testID ? `${testID}-action` : undefined} />
      </Row>
    );
  }
  if (onPress) {
    return (
      <Pressable {...frame} aria-label={accessibilityLabel ?? title} onPress={onPress} feedback="highlight">
        {content}
      </Pressable>
    );
  }
  return <Row {...frame}>{content}</Row>;
}
