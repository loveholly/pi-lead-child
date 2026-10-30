import type { UniversalBaseProps } from '@expo/ui';

export type NativeModifiers = NonNullable<UniversalBaseProps['modifiers']>;

// 让 Expo UI 原生控件横向占满父容器的平台修饰符。iOS 见 .ios.ts，Android 见 .android.ts。
// 这个文件只给类型检查和非 iOS/Android 平台用，不加任何修饰符。
export function fullWidthModifiers(): NativeModifiers {
  return [];
}
