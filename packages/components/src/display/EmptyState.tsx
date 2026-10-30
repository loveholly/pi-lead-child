import { View } from '@tamagui/core';
import type { ReactNode } from 'react';

import { Button } from '../controls/Button';
import { Text } from '../primitives/Text';
import type { ColorToken } from '../theme/tokens';
import { Icon } from './Icon';
import type { IconName } from './icons';

export type EmptyStateProps = {
  title: string;
  body?: string;
  icon?: IconName;
  iconColor?: ColorToken;
  iconBackground?: ColorToken;
  action?: { label: string; onPress: () => void; testID?: string };
  // 正文和操作按钮之间的额外内容，例如几条示例指令。
  children?: ReactNode;
  testID?: string;
};

// 空状态：图标、标题、说明和一个可选的操作。
export function EmptyState({
  title, body, icon, iconColor = 'accent', iconBackground = 'surface', action, children, testID,
}: EmptyStateProps) {
  return (
    <View testID={testID} w="100%" items="center" px="empty-state" pt="empty-state" pb="empty-state">
      {icon ? (
        <View w={62} h={62} rounded="4xl" bg={iconBackground} items="center" justify="center">
          <Icon name={icon} size={23} color={iconColor} weight="bold" />
        </View>
      ) : null}
      <View w="100%" items="center" gap="text-stack" pt={icon ? 22 : 0}>
        <Text size="section-title" weight="extrabold" align="center">{title}</Text>
        {body ? <Text size="secondary" tone="muted" align="center">{body}</Text> : null}
      </View>
      {/* spacing-exempt: 示例内容与正文的间距 */}
      {children ? <View w="100%" pt={18}>{children}</View> : null}
      {action ? (
        // spacing-exempt: 按钮与内容的间距
        <View pt={20} items="center">
          <Button label={action.label} onPress={action.onPress} variant="outline" tone="neutral" size="md" testID={action.testID} />
        </View>
      ) : null}
    </View>
  );
}
