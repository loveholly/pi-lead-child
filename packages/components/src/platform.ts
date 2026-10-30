import { AppState, Linking, Platform, useWindowDimensions } from 'react-native';

import { breakpoints } from './theme/tokens';

// 平台和窗口信息。应用通过这里读，不直接依赖 react-native。
export const platformOS = Platform.OS;
export const isWeb = Platform.OS === 'web';
export const isIOS = Platform.OS === 'ios';
export const isAndroid = Platform.OS === 'android';

export type Breakpoint = { width: number; height: number; tablet: boolean; desktop: boolean; wide: boolean };

// 当前窗口落在哪个断点上。desktop 是工作台三栏布局的阈值（tokens.breakpoints）。
export function useBreakpoint(): Breakpoint {
  const { width, height } = useWindowDimensions();
  return {
    width,
    height,
    tablet: width >= breakpoints.tablet,
    desktop: width >= breakpoints.desktop,
    wide: width >= breakpoints.wide,
  };
}

const SAFE_PROTOCOLS = new Set(['https:', 'http:', 'mailto:', 'tel:']);

// 只放行 http(s)、mailto 和 tel 链接。其他协议（javascript:、file: 等）返回 null。
export function safeLink(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol) ? href : null;
  } catch {
    return null;
  }
}

// 用系统浏览器或对应的应用打开链接。不安全的链接直接忽略。
export function openURL(href: string): void {
  const safe = safeLink(href);
  if (safe) void Linking.openURL(safe).catch(() => {});
}

// 应用是否在前台（web 上是标签页是否可见，react-native-web 的 AppState 按 document.visibilityState 给出）。
export function appInForeground(): boolean {
  return AppState.currentState === 'active';
}

// 订阅前后台切换。返回取消订阅的函数。
export function subscribeAppForeground(listener: (foreground: boolean) => void): () => void {
  const subscription = AppState.addEventListener('change', (state) => listener(state === 'active'));
  return () => subscription.remove();
}

// 复制文字到剪贴板（代码块的复制按钮）。web 上用浏览器的剪贴板接口。原生上还没有剪贴板模块（要加 expo-clipboard），
// canCopyText 为 false，复制按钮不显示。
export const canCopyText = Platform.OS === 'web';

export async function copyText(text: string): Promise<boolean> {
  if (Platform.OS !== 'web') return false;
  try {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // 没有权限（例如非安全上下文）：用下面的旧办法。
  }
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand?.('copy') ?? false;
  area.remove();
  return copied;
}
