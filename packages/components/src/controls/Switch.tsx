import { View } from '@tamagui/core';

import { Text } from '../primitives/Text';
import type { SwitchProps } from './Switch.types';

export type { SwitchProps } from './Switch.types';

// web 实现。原生实现见 Switch.native.tsx。
export function Switch({ value, onValueChange, label, disabled = false, testID }: SwitchProps) {
  return (
    <View
      testID={testID}
      role="switch"
      aria-checked={value}
      aria-disabled={disabled || undefined}
      aria-label={label}
      flexDirection="row"
      items="center"
      gap="side-item"
      cursor={disabled ? 'default' : 'pointer'}
      opacity={disabled ? 0.5 : 1}
      onPress={disabled ? undefined : () => onValueChange(!value)}
    >
      {/* spacing-exempt: 轨道内边距 */}
      <View w={36} h={20} p={2} rounded="full" bg={value ? 'accent' : 'border-strong'} transition="quick">
        <View w={16} h={16} rounded="full" bg="surface" x={value ? 16 : 0} transition="quick" boxShadow="0 1px 2px rgba(16,24,40,0.2)" />
      </View>
      {label ? <Text size="label" weight="medium">{label}</Text> : null}
    </View>
  );
}
