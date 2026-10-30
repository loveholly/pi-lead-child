import type { UniversalBaseProps } from '@expo/ui';
import { fillMaxWidth } from '@expo/ui/jetpack-compose/modifiers';

export type NativeModifiers = NonNullable<UniversalBaseProps['modifiers']>;

// Jetpack Compose：fillMaxWidth 让控件占满 Host 给它的宽度。
export function fullWidthModifiers(): NativeModifiers {
  return [fillMaxWidth()];
}
