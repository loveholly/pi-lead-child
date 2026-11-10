import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

import { UIProvider } from '../src';

// 在组件库的根下渲染，和应用里一样。
export function renderUI(element: ReactElement) {
  return render(<UIProvider>{element}</UIProvider>);
}

// 一个设计 token（CSS 变量）的标准值，例如 cssVar('--c-surface') 是 '#FFFFFF'。
// happy-dom 的 getComputedStyle 会解析 CSS 变量，读到的是具体值，不是 var(--c-surface) 这种写法。
// 断言「这里用的是某个 token」时，拿它和这个 token 的值比。两个 token 的值相同时，这个断言分不出它们。
// 颜色、间距这些 token 定义在文档根上。字号、行高定义在字体类（font_body 等）上：传入一个文字元素，
// 按它的字体类在 body 下面另放一个元素去读，读到的是区域和外观设置之外的标准值。
export function cssVar(name: `--${string}`, text?: Element): string {
  const font = text ? [...text.classList].find((name) => name.startsWith('font_')) : undefined;
  if (!font) return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const probe = document.createElement('span');
  probe.className = font;
  document.body.append(probe);
  try {
    return getComputedStyle(probe).getPropertyValue(name).trim();
  } finally {
    probe.remove();
  }
}
