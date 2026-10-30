import type { ReactNode } from 'react';

import { IconButton } from '../controls/Button';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { textLeading } from '../theme/tokens';

export type DetailHeaderProps = {
  /** 编号，等宽，例如 #102。没有编号的面板（例如视图面板）不给。 */
  id?: string;
  /** 完整标题。可以换行，不截断；收成一行时超出用省略号。 */
  title: string;
  /** 标题下面一行的标签，例如状态和优先级的徽章。 */
  badges?: ReactNode;
  /** 跟在标签后面的项目名，前面一个强调色的小方块。 */
  project?: string;
  /** 往下滚动以后收成一行：只留编号、标题和右边的按钮（第四轮画板）。 */
  compact?: boolean;
  /** 关闭按钮左边的内容，例如「更多」的 Popover。 */
  more?: ReactNode;
  /** 右上角的关闭（桌面侧滑栏）。 */
  onClose?: () => void;
  closeLabel?: string;
  /** 左上角的返回（手机全屏页）。给了它就不画关闭；它也是关掉这一页，testID 和关闭一样。 */
  onBack?: () => void;
  backLabel?: string;
  /** 手机全屏页：上面的留白更紧一些（左右的留白跟着外面的密度区域）。 */
  dense?: boolean;
  testID?: string;
};

// 详情页的头部（第四轮画板）：编号、完整标题、状态和项目，右边是「更多」和关闭。
// 头部放在滚动区外，往下翻也知道在看哪一张；滚动以后由调用方传 compact，收成一行。
export function DetailHeader({
  id, title, badges, project, compact = false, more, onClose, closeLabel = '关闭', onBack, backLabel = '返回', dense = false,
  testID,
}: DetailHeaderProps) {
  const back = onBack ? (
    <IconButton testID={testID ? `${testID}-close` : undefined} icon="back" label={backLabel} onPress={onBack} variant="soft" size="xs" rounded="sm" iconSize={15} iconColor="text-secondary" />
  ) : null;
  const close = !onBack && onClose ? (
    <IconButton testID={testID ? `${testID}-close` : undefined} icon="close" label={closeLabel} onPress={onClose} variant="soft" size="xs" rounded="sm" iconSize={15} iconColor="text-secondary" />
  ) : null;
  // 按钮 28 高，标题一行的高度由字号带来（section-title 的行高）。按钮放在和第一行一样高的盒子里居中，
  // 标题换行时按钮仍然对着第一行。
  const lineBox = (child: ReactNode) => <Box shrink={0} h={textLeading['section-title']} items="center" justify="center">{child}</Box>;
  return (
    <Column
      testID={testID}
      px="page-x"
      pt={compact || dense ? 'card-section' : 'page-top'}
      pb="card-section"
      gap="card-row"
      borderBottomWidth={1}
      borderBottomColor="border-soft"
      bg="surface"
    >
      <Row items="flex-start" gap="inline-item">
        {back ? lineBox(back) : null}
        {id ? <Text testID={testID ? `${testID}-id` : undefined} shrink={0} size="meta" mono weight="bold" tone="secondary">{id}</Text> : null}
        <Box flex={1} minW={0}>
          <Text testID={testID ? `${testID}-title` : undefined} role="heading" size="section-title" weight="extrabold" numberOfLines={compact ? 1 : undefined}>
            {title}
          </Text>
        </Box>
        {more ? lineBox(more) : null}
        {close ? lineBox(close) : null}
      </Row>
      {compact || (!badges && !project) ? null : (
        <Row testID={testID ? `${testID}-meta` : undefined} minH={24} flexWrap="wrap" items="center" gap="inline-item">
          {badges}
          {project ? (
            <Row items="center" gap="icon-label" minW={0}>
              <Box w={8} h={8} rounded={2} bg="accent" />
              <Text size="meta" weight="bold" tone="secondary" numberOfLines={1}>{project}</Text>
            </Row>
          ) : null}
        </Row>
      )}
    </Column>
  );
}
