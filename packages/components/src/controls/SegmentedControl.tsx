import { View } from '@tamagui/core';

import { Text } from '../primitives/Text';
import type { SegmentedControlProps } from './SegmentedControl.types';

export type { SegmentedControlProps, SegmentedOption } from './SegmentedControl.types';

// web 实现：浅灰轨道上的白色选中块。原生实现见 SegmentedControl.native.tsx。
export function SegmentedControl<T extends string>({
  options, value, onChange, size = 'md', testID, optionTestID,
}: SegmentedControlProps<T>) {
  const height = size === 'md' ? 32 : 28;
  return (
    // spacing-exempt: 轨道内边距和段间距是控件自己的规格
    <View testID={testID} role="tablist" flexDirection="row" gap={2} p={3} rounded="lg" bg="surface-muted">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <View
            key={option.value}
            testID={optionTestID?.(option.value)}
            role="tab"
            aria-selected={selected}
            flex={1}
            // spacing-exempt: 每一段自带左右留白，控件不靠父容器撑宽也有形状（2026-10-23）
            px={size === 'md' ? 14 : 12}
            minH={height}
            h={height}
            rounded={9}
            items="center"
            justify="center"
            cursor="pointer"
            bg={selected ? 'surface' : 'transparent'}
            boxShadow={selected ? '0 1px 2px rgba(16,24,40,0.08)' : 'none'}
            onPress={() => onChange(option.value)}
          >
            <Text
              size={size === 'md' ? '13' : '12'}
              weight={selected ? 'extrabold' : 'bold'}
              tone={selected ? 'default' : 'secondary'}
              align="center"
              numberOfLines={1}
            >
              {option.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
