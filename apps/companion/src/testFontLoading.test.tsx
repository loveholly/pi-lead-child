// @vitest-environment jsdom
// 测试环境本身的约定：图标不在 jsdom 里加载字体。
// Icon 用 expo-symbols 的 SymbolView，它在 web 上调 expo-font 的 loadAsync。jsdom 没有字体，
// expo-font 就用 fontfaceobserver 每 25ms 轮询一次，最多 12 秒。测试文件早就跑完了，轮询还在，
// jsdom 拆掉以后它读 document.hidden，抛 `TypeError: Cannot read properties of undefined (reading 'hidden')`。
// 整套跑时这个未捕获的异常让 vitest 退出码为 1，单独跑一个文件又碰不到（2026-11-06，#279）。
// test/setup.ts 把 loadAsync 换成永远不结束的 Promise：图标和以前一样停在「字体没加载」的空占位，但不再起轮询。
import { Icon } from '@pi-lead-child/components';
import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderUI } from '../test/render';

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
