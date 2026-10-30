import { SegmentedControl as NativeSegmentedControl } from '@expo/ui/community/segmented-control';

import { palette } from '../theme/tokens';
import type { SegmentedControlProps } from './SegmentedControl.types';

export type { SegmentedControlProps, SegmentedOption } from './SegmentedControl.types';

// 原生实现：iOS 上是 UISegmentedControl，Android 上是 Compose SegmentedButton（Expo UI）。
export function SegmentedControl<T extends string>({
  options, value, onChange, size = 'md', testID,
}: SegmentedControlProps<T>) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  return (
    <NativeSegmentedControl
      testID={testID}
      values={options.map((option) => option.label)}
      selectedIndex={selectedIndex}
      tintColor={palette.surface}
      appearance="light"
      onChange={(event) => {
        const option = options[event.nativeEvent.selectedSegmentIndex];
        if (option && option.value !== value) onChange(option.value);
      }}
      style={{ height: size === 'md' ? 34 : 30, alignSelf: 'stretch' }}
    />
  );
}
