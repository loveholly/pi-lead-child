// 聊天列表（ChatScroll）：主会话和工单对话共用。2026-10-16 用户报告：工单对话滚不动；要求两处都默认落在最底下、
// 跟随流式输出、往上翻时不拽回来，只给「新消息 ↓」。
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatScroll, Column, Text } from '../src';
import {
  chatFollowOnContent,
  chatFollowOnScroll,
  chatFollowToBottom,
  chatReflowAnchor,
  INITIAL_CHAT_FOLLOW,
  PRESSED_ANCHOR_MS,
  type ChatFollow,
} from '../src/display/stickToBottom';
import { renderUI } from './render';

describe('the chat list layout', () => {
  // 根因：内容区写了 flex 1。react-native-web 给它 flex-basis 0、min-height 0，内容缩成一屏高，
  // 贴底对齐时多出来的部分溢出到顶部之外，滚动区量到的内容高度就是一屏，滚不动。
  it('lets the content grow past the viewport and never shrinks it, so a long conversation scrolls', () => {
    renderUI(
      <Column h={400}>
        <ChatScroll testID="chat"><Text>一条消息</Text></ChatScroll>
      </Column>,
    );
    const content = getComputedStyle(screen.getByTestId('chat-content'));
    expect(content.flexGrow).toBe('1');
    expect(content.flexShrink).toBe('0');
    expect(content.flexBasis).toBe('auto');
    expect(content.justifyContent).toBe('flex-end');
  });
});

describe('following the bottom', () => {
  const geometry = (offsetY: number, contentHeight: number, viewportHeight = 600) => ({ offsetY, contentHeight, viewportHeight });
  const atBottom: ChatFollow = { stuck: true, offsetY: 1400, contentHeight: 2000, contentWidth: 700, positioned: true, newBelow: false };

  it('lands at the bottom without animation the first time it has content', () => {
    const { state, move } = chatFollowOnContent(INITIAL_CHAT_FOLLOW, geometry(0, 3000));
    expect(move).toBe('jump');
    expect(state).toMatchObject({ positioned: true, stuck: true, contentHeight: 3000 });
  });

  it('follows a streaming reply smoothly while you are at the bottom', () => {
    expect(chatFollowOnContent(atBottom, geometry(1400, 2040)).move).toBe('follow');
  });

  it('jumps instead of playing a long scroll when a whole screen or more arrives at once', () => {
    expect(chatFollowOnContent(atBottom, geometry(1400, 2000 + 700)).move).toBe('jump');
  });

  it('leaves you where you are when you scrolled up, and says there is something new below', () => {
    const reading = chatFollowOnScroll(atBottom, geometry(300, 2000));
    expect(reading.stuck).toBe(false);
    const { state, move } = chatFollowOnContent(reading, geometry(300, 2100));
    expect(move).toBe('none');
    expect(state.newBelow).toBe(true);
  });

  it('does not call a shorter list new content', () => {
    const reading = chatFollowOnScroll(atBottom, geometry(300, 2000));
    expect(chatFollowOnContent(reading, geometry(300, 1800)).state.newBelow).toBe(false);
  });

  it('follows again, and hides the hint, once you are back at the bottom', () => {
    const reading = { ...chatFollowOnScroll(atBottom, geometry(300, 2000)), newBelow: true };
    expect(chatFollowOnScroll(reading, geometry(1500, 2100))).toMatchObject({ stuck: true, newBelow: false });
  });

  it('goes back to the bottom when you send a message or press the hint', () => {
    const reading = { ...chatFollowOnScroll(atBottom, geometry(300, 2000)), newBelow: true };
    expect(chatFollowToBottom(reading)).toMatchObject({ stuck: true, newBelow: false });
  });
});

// 2026-10-16：工单面板打开、关闭时，会话栏变窄、变宽，内容重新排版。实测（1440 宽）：
// 你点的工单卡往下跳了 19 px，下面还冒出「新消息 ↓」，其实没有新消息。
describe('when the pane changes width', () => {
  const geometry = (offsetY: number, contentHeight: number, contentWidth: number) => ({ offsetY, contentHeight, viewportHeight: 600, contentWidth });
  const reading: ChatFollow = { stuck: false, offsetY: 900, contentHeight: 2000, contentWidth: 1106, positioned: true, newBelow: false };

  it('does not call the reflowed text new content', () => {
    const { state, move } = chatFollowOnContent(reading, geometry(900, 2400, 537));
    expect(state.newBelow).toBe(false);
    expect(move).toBe('reflow');
    expect(state.contentWidth).toBe(537);
  });

  it('does not start a scroll to the bottom for a reflow while you are at the bottom', () => {
    expect(chatFollowOnContent({ ...reading, stuck: true }, geometry(1400, 2400, 537)).move).toBe('reflow');
  });

  it('keeps the block you just pressed, else the bottom when you are there, else the middle of the view', () => {
    expect(chatReflowAnchor(reading, { visible: true, ageMs: 300 })).toBe('pressed');
    expect(chatReflowAnchor({ ...reading, stuck: true }, { visible: true, ageMs: 300 })).toBe('pressed');
    expect(chatReflowAnchor({ ...reading, stuck: true }, { visible: false, ageMs: 300 })).toBe('bottom');
    expect(chatReflowAnchor({ ...reading, stuck: true }, { visible: true, ageMs: PRESSED_ANCHOR_MS + 1 })).toBe('bottom');
    expect(chatReflowAnchor(reading, null)).toBe('middle');
  });
});

describe('the chat list on web when the pane changes width', () => {
  const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];
  afterEach(() => {
    observers.length = 0;
    vi.unstubAllGlobals();
  });

  it('keeps the card you clicked at the same height', () => {
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
    renderUI(
      <Column h={600}>
        <ChatScroll testID="chat" bottomAligned={false}>
          <Text>很长的回复</Text>
          <Text testID="card">工单卡</Text>
        </ChatScroll>
      </Column>,
    );
    const scroll = screen.getByTestId('chat');
    const card = screen.getByTestId('card');
    // jsdom 不排版：几何量都由测试给出。会话栏宽 1106 时，卡片在可视区顶部往下 453 px。
    let width = 1106;
    let cardTop = 453;
    let scrollTop = 1840;
    Object.defineProperty(scroll, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => 4000 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 600 });
    scroll.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: width, width, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    card.getBoundingClientRect = () => ({ top: cardTop, bottom: cardTop + 60, left: 0, right: width, width, height: 60, x: 0, y: cardTop, toJSON: () => ({}) });

    // 浏览器通知每一个在看这个元素的 ResizeObserver（react-native-web 的 onLayout 也在看它）。
    const watching = observers.filter((entry) => entry.targets.includes(scroll));
    expect(watching.length).toBeGreaterThan(0);
    const resized = () => act(() => watching.forEach((entry) => entry.callback([], {} as ResizeObserver)));
    // 第一次量到宽度：不是宽度变了。
    resized();
    expect(scrollTop).toBe(1840);

    fireEvent.pointerDown(card);
    // 面板打开：会话栏变窄到 537，上面的文字换行变多，卡片被推下去 19 px。
    width = 537;
    cardTop = 472;
    resized();
    // 往下滚 19 px，卡片回到原来的高度。
    expect(scrollTop).toBe(1859);
  });
});
