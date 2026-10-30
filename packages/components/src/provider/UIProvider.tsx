import { TamaguiProvider } from '@tamagui/core';
import type { PropsWithChildren } from 'react';
import { Appearance } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { config } from '../theme/config';

// 应用固定用浅色外观：组件库只有 light 主题，原生控件（SwiftUI、Compose）也要跟着用浅色。
if (typeof Appearance.setColorScheme === 'function') Appearance.setColorScheme('light');

// web 上每个字重是一个独立的字体文件，CSS 的 font-weight 是这个文件的真实字重（见 theme/config.ts）。
// 浏览器看到字体文件声明的字重比要求的低，会再合成一次粗体，英文就粗了两遍。关掉合成；
// 回退的中文字体有真正的粗体，不受影响。
const FONT_CSS = 'html { font-synthesis: none; }';
if (typeof document !== 'undefined' && !document.getElementById('ui-font-synthesis')) {
  const style = document.createElement('style');
  style.id = 'ui-font-synthesis';
  style.textContent = FONT_CSS;
  document.head.appendChild(style);
}

// 组件库的根。放在应用最外层，每个应用只放一次。
export function UIProvider({ children }: PropsWithChildren) {
  return (
    <SafeAreaProvider>
      <TamaguiProvider config={config} defaultTheme="light">
        {children}
      </TamaguiProvider>
    </SafeAreaProvider>
  );
}

// 静态导出时首屏需要的 CSS。放进 web 的 HTML 模板（expo-router 的 +html.tsx）的 <head>，
// 页面在 JavaScript 加载之前就有正确的样式。原生上不需要它。
export function UIServerStyles() {
  return <style id="ui-server-styles" dangerouslySetInnerHTML={{ __html: `${FONT_CSS}\n${config.getCSS()}` }} />;
}
