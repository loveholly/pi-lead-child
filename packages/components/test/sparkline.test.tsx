// 走势小图（2026-10-30 用户采纳：react-native-svg 自己画，docs/genui-design.md 第 8 节 Sparkline）。
// 一条折线，最后一个点是「现在」；参照线是虚线；线的颜色按 tone，跟着外观里的颜色设置；量到宽度以前是同高的占位。
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesignPreferencesProvider, Sparkline, designColorOverrides, palette } from '../src';
import { renderUI } from './render';

// happy-dom 没有布局：让每个元素量出来都是 300 宽，Tamagui 的 onLayout 才会报宽度。
function withWidth(width: number) {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: width, bottom: 48, width, height: 48, toJSON: () => ({}),
  } as DOMRect);
}

afterEach(() => vi.restoreAllMocks());

describe('Sparkline', () => {
  const points = [18110, 18240, 18190, 18310, 18532];

  it('says the whole trend in words, and writes the range under the line', () => {
    renderUI(<Sparkline testID="ndx" points={points} label="纳斯达克" unit="点" start="10-24" end="今天" />);
    expect(screen.getByLabelText('纳斯达克: From 18,110 点 to 18,532 点. Highest 18,532 点, lowest 18,110 点.')).toBeTruthy();
    expect(screen.getByText('10-24 → 今天')).toBeTruthy();
    expect(screen.getByText('High 18,532 · Low 18,110')).toBeTruthy();
  });

  // 界面语言是中文时，组件库的文案跟着换（外观偏好的 locale）。
  it('speaks Chinese when the interface language is Chinese', () => {
    renderUI(
      <DesignPreferencesProvider value={{ locale: 'zh' }}>
        <Sparkline points={points} label="纳斯达克" unit="点" />
      </DesignPreferencesProvider>,
    );
    expect(screen.getByLabelText('纳斯达克：从 18,110 点 到 18,532 点，最高 18,532 点，最低 18,110 点')).toBeTruthy();
    expect(screen.getByText('最高 18,532 · 最低 18,110')).toBeTruthy();
  });

  it('draws one line, a dot for now, and a dashed baseline, in the tone colour after the width is known', async () => {
    withWidth(300);
    const { container } = renderUI(<Sparkline points={points} tone="success" baseline={18200} />);
    await waitFor(() => expect(container.querySelector('svg polyline')).toBeTruthy());
    const line = container.querySelector('svg polyline')!;
    expect(line.getAttribute('stroke')?.toUpperCase()).toBe(palette.success.toUpperCase());
    expect(line.getAttribute('points')!.split(' ')).toHaveLength(points.length);
    expect(container.querySelector('svg circle')).toBeTruthy();
    expect(container.querySelector('svg line')?.getAttribute('stroke-dasharray')).toBe('4 4');
  });

  it('follows the appearance colour setting', async () => {
    withWidth(300);
    const accent = '#7C3AED';
    const { container } = renderUI(
      <DesignPreferencesProvider value={{ colors: { accent, success: palette.success, warning: palette.warning, danger: palette.danger, info: palette.cyan } }}>
        <Sparkline points={points} />
      </DesignPreferencesProvider>,
    );
    await waitFor(() => expect(container.querySelector('svg polyline')).toBeTruthy());
    const expected = designColorOverrides({ accent, success: palette.success, warning: palette.warning, danger: palette.danger, info: palette.cyan }).accent!;
    expect(container.querySelector('svg polyline')!.getAttribute('stroke')?.toUpperCase()).toBe(expected.toUpperCase());
  });
});
