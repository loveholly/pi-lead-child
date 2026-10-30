import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { palette, type ColorToken } from '../theme/tokens';

export type ScreenProps = {
  children?: ReactNode;
  // 要避开的安全区边，例如 ['top'] 或 ['top', 'bottom']。
  edges?: readonly Edge[];
  bg?: ColorToken;
  testID?: string;
};

// 一屏内容的根：避开刘海、Home 指示条等安全区，铺满父容器。
export function Screen({ children, edges = ['top', 'bottom'], bg = 'workspace', testID }: ScreenProps) {
  return (
    <SafeAreaView testID={testID} edges={edges} style={{ flex: 1, backgroundColor: palette[bg] }}>
      {children}
    </SafeAreaView>
  );
}

export type KeyboardAreaProps = {
  children?: ReactNode;
  bg?: ColorToken;
  testID?: string;
};

// 键盘弹出时把内容顶上去。只有 iOS 需要：Android 由系统调整窗口，web 没有软键盘遮挡。
export function KeyboardArea({ children, bg, testID }: KeyboardAreaProps) {
  return (
    <KeyboardAvoidingView
      testID={testID}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, minWidth: 0, backgroundColor: bg ? palette[bg] : undefined }}
    >
      {children}
    </KeyboardAvoidingView>
  );
}
