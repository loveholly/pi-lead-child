// 二维码组件：按点阵画深色模块，四周留静区，白底黑码不随主题变。
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { QrCode, qrDarkRuns } from '../src';
import { renderUI } from './render';

// 21×21 是最小的二维码（版本 1）。这里只要形状对，不要求是能扫的码。
const rows = Array.from({ length: 21 }, (_, y) => {
  if (y === 0) return '1'.repeat(21);
  if (y === 1) return '101' + '0'.repeat(15) + '111';
  return '0'.repeat(21);
});

describe('qrDarkRuns', () => {
  it('joins the dark modules of a row into runs', () => {
    expect(qrDarkRuns(rows)).toEqual([
      { y: 0, x: 0, length: 21 },
      { y: 1, x: 0, length: 1 },
      { y: 1, x: 2, length: 1 },
      { y: 1, x: 18, length: 3 },
    ]);
    expect(qrDarkRuns(['0000'])).toEqual([]);
  });
});

describe('QrCode', () => {
  it('draws one view per run inside a white square with the quiet zone', () => {
    renderUI(<QrCode rows={rows} moduleSize={4} testID="qr" accessibilityLabel="配对二维码" />);
    const qr = screen.getByTestId('qr');
    expect(qr.getAttribute('role')).toBe('img');
    expect(qr.getAttribute('aria-label')).toBe('配对二维码');
    const style = getComputedStyle(qr);
    // (21 + 2 × 4) × 4 = 116。
    expect(style.width).toBe('116px');
    expect(style.height).toBe('116px');
    expect(style.backgroundColor).toBe('var(--c-white)');

    const modules = [...qr.children] as HTMLElement[];
    expect(modules).toHaveLength(4);
    const last = getComputedStyle(modules[3]!);
    expect(last.position).toBe('absolute');
    // 第 2 行（y=1）的 x=18 起，各加 4 个模块的静区。
    expect(last.top).toBe(`${(1 + 4) * 4}px`);
    expect(last.left).toBe(`${(18 + 4) * 4}px`);
    expect(last.width).toBe('12px');
    expect(last.height).toBe('4px');
    expect(last.backgroundColor).toBe('var(--c-black)');
  });
});
