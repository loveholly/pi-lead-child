import type { UniversalBaseProps } from '@expo/ui';
import { frame } from '@expo/ui/swift-ui/modifiers';

export type NativeModifiers = NonNullable<UniversalBaseProps['modifiers']>;

// SwiftUI：把控件的最大宽度放开，它就会占满 Host 给它的宽度。
export function fullWidthModifiers(): NativeModifiers {
  return [frame({ maxWidth: Number.POSITIVE_INFINITY })];
}
