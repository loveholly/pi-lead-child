import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

import { UIProvider } from '../src';

// 在组件库的根下渲染，和应用里一样。
export function renderUI(element: ReactElement) {
  return render(<UIProvider>{element}</UIProvider>);
}
