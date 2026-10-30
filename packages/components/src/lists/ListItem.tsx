import { View } from '@tamagui/core';

import { Text } from '../primitives/Text';
import type { ListItemProps, ListProps } from './ListItem.types';

export type { ListItemProps, ListProps } from './ListItem.types';

// web 实现。原生实现见 ListItem.native.tsx。
export function List({ children, testID }: ListProps) {
  return (
    <View testID={testID} role="list" w="100%">
      {children}
    </View>
  );
}

export function ListItem({
  title, subtitle, subtitleLines = 1, leading, trailing, footer, onPress, selected = false, mono = false, testID,
}: ListItemProps) {
  return (
    <View
      testID={testID}
      role={onPress ? 'button' : 'listitem'}
      flexDirection="row"
      items="center"
      gap="side-item"
      minH={56}
      px="row-x"
      py="row-y"
      rounded="md"
      cursor={onPress ? 'pointer' : undefined}
      bg={onPress ? { default: 'transparent', hover: 'surface-subtle', press: 'surface-muted' } : 'transparent'}
      onPress={onPress}
    >
      {leading ? <View shrink={0}>{leading}</View> : null}
      <View flex={1} minW={0} gap="text-stack">
        <Text
          size={mono ? '12.5' : '13'}
          mono={mono}
          weight={selected ? 'extrabold' : mono ? 'bold' : 'regular'}
          tone={selected ? 'accent' : 'default'}
          leading={18} // spacing-exempt: 标题行高
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle ? <Text size="secondary" tone="muted" numberOfLines={subtitleLines}>{subtitle}</Text> : null}
        {footer}
      </View>
      {trailing ? <View shrink={0}>{trailing}</View> : null}
    </View>
  );
}
