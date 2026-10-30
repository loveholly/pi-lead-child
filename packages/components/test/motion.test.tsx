import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Grow, growTimings, SlidePanel, Text, UIProvider } from '../src';
import { renderUI } from './render';

describe('SlidePanel', () => {
  it('exposes a modal panel as a dialog that covers its parent', () => {
    renderUI(<SlidePanel edge="right" modal><Text testID="body">工单</Text></SlidePanel>);
    // Reanimated 在 web 上先把入场的元素设为 visibility: hidden，动画开始时再显示。jsdom 不运行动画，所以要带上 hidden。
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(dialog.contains(screen.getByTestId('body'))).toBe(true);
    expect(getComputedStyle(dialog).position).toBe('absolute');
  });

  it('sizes a docked panel in the parent row and is not a dialog', () => {
    renderUI(
      <SlidePanel edge="left" grow={288} basis={0} minWidth={288} maxWidth={360}>
        <Text testID="rail">侧栏</Text>
      </SlidePanel>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    // 动画容器是内容 Box 的父元素，宽度约束放在它上面。
    const container = screen.getByTestId('rail').parentElement!.parentElement!;
    const style = getComputedStyle(container);
    expect(style.flexGrow).toBe('288');
    expect(style.minWidth).toBe('288px');
    expect(style.maxWidth).toBe('360px');
  });
});

// 撑开（P12.1 的 Grow，主题 M-1 到 M-3）：输入框上的排队状态栏从那一行往上长（主题 11.13，2026-10-28）。
describe('Grow', () => {
  // 2026-10-28 预览里点出来的：收着时高度是 0，里面的按钮却还点得到、Tab 走得到。收好以后不再渲染内容。
  it('renders its content only while open, and removes it once it has closed', async () => {
    const view = renderUI(<Grow open={false} testID="grow"><Text testID="inside">排队 3</Text></Grow>);
    expect(screen.getByTestId('grow').getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByTestId('inside')).toBeNull();
    view.rerender(<UIProvider><Grow open testID="grow"><Text testID="inside">排队 3</Text></Grow></UIProvider>);
    expect(screen.getByTestId('grow').getAttribute('aria-hidden')).not.toBe('true');
    expect(screen.getByTestId('grow').contains(screen.getByTestId('inside'))).toBe(true);
    view.rerender(<UIProvider><Grow open={false} testID="grow"><Text testID="inside">排队 3</Text></Grow></UIProvider>);
    expect(screen.getByTestId('grow').getAttribute('aria-hidden')).toBe('true');
    await waitFor(() => expect(screen.queryByTestId('inside')).toBeNull());
  });

  it('uses the theme timings for grow and reveal', () => {
    expect(growTimings).toEqual({ OPEN_MS: 220, CLOSE_MS: 170, REVEAL_MS: 170, REVEAL_DELAY_MS: 60, FADE_OUT_MS: 130, REVEAL_SHIFT: 4 });
  });
});
