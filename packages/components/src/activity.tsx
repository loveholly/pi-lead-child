import type { PropsWithChildren } from 'react';
import { AppState, StyleSheet, View } from 'react-native';

import { isWeb } from './platform';

// 用户操作（点按、键盘、触摸、滚动）的订阅。应用据此判断"最近有没有人在看"。
// web：document 上的 pointerdown、keydown、touchstart、wheel。
// 原生：没有全局的触摸事件，所以根部放一个 ActivityBoundary 收触摸；切回前台也算一次操作。
const nativeListeners = new Set<() => void>();
const emitNative = () => { for (const listener of nativeListeners) listener(); };

export function subscribeUserActivity(listener: () => void): () => void {
  const cleanups: Array<() => void> = [];
  if (isWeb && typeof document !== 'undefined') {
    for (const type of ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const) {
      document.addEventListener(type, listener, { capture: true, passive: true });
      cleanups.push(() => document.removeEventListener(type, listener, { capture: true }));
    }
  } else {
    nativeListeners.add(listener);
    cleanups.push(() => nativeListeners.delete(listener));
  }
  const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') listener(); });
  cleanups.push(() => subscription.remove());
  return () => { for (const cleanup of cleanups) cleanup(); };
}

// 原生上收集触摸的根容器（touchstart 会冒泡到这里）。web 上不加任何元素，不影响布局。
export function ActivityBoundary({ children }: PropsWithChildren) {
  if (isWeb) return <>{children}</>;
  return <View style={styles.fill} onTouchStart={emitNative}>{children}</View>;
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
