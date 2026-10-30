import { UIProvider } from '@pi-lead-child/components';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

// 在组件库的根下渲染，和应用里一样。只能在 jsdom 环境的测试里用。
export function renderUI(element: ReactElement) {
  return render(<UIProvider>{element}</UIProvider>);
}

// Tamagui 在 web 上用字体类（font_<token>）选字体。jsdom 不解析 CSS 变量，所以读类名。
export function fontClass(element: Element): string | undefined {
  return [...element.classList].find((name) => name.startsWith('font_'));
}
