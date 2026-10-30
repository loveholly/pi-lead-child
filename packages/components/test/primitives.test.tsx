import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Box, measure, Row, ScrollArea, Text } from '../src';
import { tokens } from '../src/theme/config';
import { renderUI } from './render';

// Tamagui 在 web 上用字体类（font_<token>）选字体，具体的 font-family 放在 CSS 变量里，jsdom 不解析变量，所以断言类名。
const fontClass = (testID: string) => [...screen.getByTestId(testID).classList].find((name) => name.startsWith('font_'));

describe('Text', () => {
  it('uses the face file of its weight', () => {
    renderUI(<Text weight="bold" testID="title">工单</Text>);
    expect(screen.getByTestId('title').textContent).toBe('工单');
    expect(fontClass('title')).toBe('font_bold');
  });

  it('uses the mono face file for mono text, by weight', () => {
    renderUI(
      <>
        <Text mono testID="medium">#42</Text>
        <Text mono weight="semibold" testID="semibold">#42</Text>
        <Text mono weight="extrabold" testID="bold">#42</Text>
      </>,
    );
    expect(fontClass('medium')).toBe('font_mono-medium');
    expect(fontClass('semibold')).toBe('font_mono-semibold');
    expect(fontClass('bold')).toBe('font_mono-bold');
  });

  it('uses the italic face files', () => {
    renderUI(
      <>
        <Text italic testID="italic">x</Text>
        <Text italic weight="bold" testID="bold-italic">x</Text>
      </>,
    );
    expect(fontClass('italic')).toBe('font_italic');
    expect(fontClass('bold-italic')).toBe('font_bold-italic');
  });

  it('defaults to the regular face', () => {
    renderUI(<Text testID="body">正文</Text>);
    expect(fontClass('body')).toBe('font_regular');
  });
});

describe('layout', () => {
  it('lays out a row horizontally and a box vertically', () => {
    renderUI(<Row testID="row"><Box testID="box" /></Row>);
    expect(getComputedStyle(screen.getByTestId('row')).flexDirection).toBe('row');
    expect(getComputedStyle(screen.getByTestId('box')).flexDirection).toBe('column');
  });
});

describe('prose measure', () => {
  it('caps a reading column at about 40 Chinese characters of 14px text', () => {
    expect(measure.prose).toBe(560);
    expect(tokens.size.prose.val).toBe(measure.prose);
    renderUI(<Box w="100%" maxW="prose" testID="reply" />);
    // jsdom 不解析 CSS 变量：断言 maxW 落在 prose 这个 size token 上。
    expect(getComputedStyle(screen.getByTestId('reply')).maxWidth).toBe('var(--t-size-prose)');
  });
});

// 2026-10-16 用户要求：会话里 Lead 一侧的块（回复、任务卡、失败卡、Lead 动态、工单卡）用同一个内容列。
// 手机上是去掉两边留白的全宽；平板和桌面上最宽 700、在会话栏里居中（宽屏上靠左时右边空出半屏，底栏和输入框也对不齐）。
// 700：14 号正文约 50 个汉字一行，和 Claude 在 16 号字下 768 宽的行长相当；760 一行约 54 个字，偏长。
describe('the conversation column', () => {
  it('is one shared width, about 700 and centered on wide screens, the full width on phones', async () => {
    const { ConversationColumn } = await import('../src');
    expect(measure.conversation).toBe(700);
    expect(tokens.size.conversation.val).toBe(measure.conversation);
    renderUI(<ConversationColumn testID="column"><Text>回复</Text></ConversationColumn>);
    const style = getComputedStyle(screen.getByTestId('column'));
    expect(style.maxWidth).toBe('var(--t-size-conversation)');
    expect(style.width).toBe('100%');
    expect(style.alignSelf).toBe('center');
  });
});

// 2026-10-16：工单面板打开、关闭时，居中的内容列一下子跳到新位置（实测 1440 宽：一帧里从 520 跳到 317）。
// 现在它滑过去：大约 200 ms、先快后慢；系统设了「减弱动态效果」时不播；只差几像素（拖动窗口边缘）时也不播。
describe('the conversation column moving with its pane', () => {
  const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];
  afterEach(() => {
    observers.length = 0;
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  });

  async function renderColumn({ reduceMotion = false } = {}) {
    vi.stubGlobal('ResizeObserver', class {
      private entry: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) { this.entry.targets.push(target); }
      unobserve() {}
      disconnect() {}
    });
    const realMatchMedia = window.matchMedia;
    vi.stubGlobal('matchMedia', (query: string) => ({ ...realMatchMedia(query), matches: reduceMotion && query.includes('prefers-reduced-motion') }));
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    (HTMLElement.prototype as unknown as { animate: typeof animate }).animate = animate;
    const { ConversationColumn } = await import('../src');
    renderUI(<Box testID="pane"><ConversationColumn testID="column"><Text>回复</Text></ConversationColumn></Box>);
    const column = screen.getByTestId('column');
    let left = 520;
    column.getBoundingClientRect = () => ({ top: 0, bottom: 100, left, right: left + 700, width: 700, height: 100, x: left, y: 0, toJSON: () => ({}) });
    const watching = observers.filter((entry) => entry.targets.includes(column.parentElement!));
    expect(watching.length).toBeGreaterThan(0);
    const move = (to: number) => {
      left = to;
      act(() => watching.forEach((entry) => entry.callback([], {} as ResizeObserver)));
    };
    // 开始观察时浏览器先通知一次当前尺寸：那一次不是移动。
    move(520);
    expect(animate).not.toHaveBeenCalled();
    return { animate, move };
  }

  it('slides from where it was to where it is now, in about 200 ms, easing out', async () => {
    const { animate, move } = await renderColumn();
    move(317);
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, timing] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
    expect(frames).toEqual([{ transform: 'translateX(203px)' }, { transform: 'translateX(0px)' }]);
    expect(timing.duration).toBe(200);
    expect(String(timing.easing)).toMatch(/cubic-bezier/);
  });

  it('jumps without a slide when the system asks for reduced motion', async () => {
    const { animate, move } = await renderColumn({ reduceMotion: true });
    move(317);
    expect(animate).not.toHaveBeenCalled();
  });

  it('does not slide for a move of a few pixels, such as dragging the window edge', async () => {
    const { animate, move } = await renderColumn();
    move(512);
    expect(animate).not.toHaveBeenCalled();
  });
});

describe('ScrollArea', () => {
  it('grows to its content up to maxH and fills the parent by default', () => {
    renderUI(
      <Box>
        <ScrollArea testID="bounded" flex={0} maxH={420}><Text>日志</Text></ScrollArea>
        <ScrollArea testID="filling"><Text>会话</Text></ScrollArea>
      </Box>,
    );
    const bounded = getComputedStyle(screen.getByTestId('bounded'));
    expect(bounded.maxHeight).toBe('420px');
    expect(bounded.flexGrow).toBe('0');
    expect(getComputedStyle(screen.getByTestId('filling')).flexGrow).toBe('1');
  });

  // 回归：react-native-web 把 flex: 0 展开成 flex: 0 1 0%。flex-basis 为 0 时，
  // 按内容定高的滚动区在有高度的父容器里塌成 0 高（工单详情的证据区因此看不见）。
  it('sizes a content-height scroll area from its content, not from a zero basis', () => {
    renderUI(<ScrollArea testID="bounded" flex={0} maxH={520}><Text>证据</Text></ScrollArea>);
    expect(getComputedStyle(screen.getByTestId('bounded')).flexBasis).toBe('auto');
  });
});
