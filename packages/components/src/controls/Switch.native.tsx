import { Host, Switch as ExpoSwitch } from '@expo/ui';

import { palette } from '../theme/tokens';
import type { SwitchProps } from './Switch.types';

export type { SwitchProps } from './Switch.types';

// 原生实现：iOS 上是 SwiftUI Toggle，Android 上是 Compose Switch（Expo UI）。
export function Switch({ value, onValueChange, label, disabled = false, testID }: SwitchProps) {
  return (
    <Host matchContents seedColor={palette.accent}>
      <ExpoSwitch value={value} onValueChange={onValueChange} label={label} disabled={disabled} testID={testID} />
    </Host>
  );
}
