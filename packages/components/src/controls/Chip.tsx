import { View } from '@tamagui/core';

import { Text } from '../primitives/Text';

export type ChipProps = {
  label: string;
  // 跟在标签后的计数。
  count?: number | string;
  selected?: boolean;
  onPress?: () => void;
  size?: 'sm' | 'md';
  testID?: string;
};

// 筛选标签：一排里可以选一个。选中时深底白字。三个平台都由 Tamagui 渲染，外观一致。
export function Chip({ label, count, selected = false, onPress, size = 'sm', testID }: ChipProps) {
  return (
    <View
      testID={testID}
      role="button"
      aria-pressed={selected}
      flexDirection="row"
      items="center"
      gap="inline-item"
      shrink={0}
      h={size === 'md' ? 30 : 27}
      px={size === 'md' ? 12 : 11}
      rounded="sm"
      cursor="pointer"
      bg={selected ? 'text' : 'surface-muted'}
      onPress={onPress}
    >
      {/* spacing-exempt: 标签字号 */}
      <Text size="12" weight="bold" color={selected ? 'surface' : 'text-secondary'} numberOfLines={1}>{label}</Text>
      {count !== undefined ? (
        // spacing-exempt: 计数字号
        <Text size="10" weight="extrabold" color={selected ? 'surface' : 'text-muted'}>{String(count)}</Text>
      ) : null}
    </View>
  );
}
