// @vitest-environment happy-dom
// 测试环境本身的约定：图标不在 happy-dom 里加载字体，原因见 test/setup.ts 和 apps/companion/src/testFontLoading.test.tsx。
import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Icon } from '../src';
import { renderUI } from './render';

describe('icons in the test environment', () => {
  it('do not start a font observer that outlives the test file', async () => {
    renderUI(<Icon name="settings" />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    // fontfaceobserver 量字宽用的探针：一个 aria-hidden 的 div，内联样式里写着要等的字体。
    const probes = [...document.body.querySelectorAll<HTMLElement>('div[aria-hidden="true"]')]
      .filter((element) => element.style.cssText.includes('MaterialSymbols'));
    expect(probes).toEqual([]);
  });
});
