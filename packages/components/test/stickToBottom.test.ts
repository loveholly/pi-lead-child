import { describe, expect, it } from 'vitest';
import { isNearBottom, nextStick, STICK_THRESHOLD_PX } from '../src/display/stickToBottom';

describe('isNearBottom', () => {
  it('sticks when the content is shorter than the viewport', () => {
    // 没有可滚动距离；判成"未贴底"会让首屏不满一屏的会话从此不再跟随新消息
    expect(isNearBottom(0, 300, 800)).toBe(true);
  });

  it('sticks at the exact bottom', () => {
    expect(isNearBottom(1200, 2000, 800)).toBe(true);
  });

  it('still sticks within the threshold', () => {
    expect(isNearBottom(1200 - STICK_THRESHOLD_PX, 2000, 800)).toBe(true);
  });

  it('releases once the user scrolls further up than the threshold', () => {
    expect(isNearBottom(1200 - STICK_THRESHOLD_PX - 1, 2000, 800)).toBe(false);
  });

  it('releases when the user is reading history far up', () => {
    expect(isNearBottom(0, 5000, 800)).toBe(false);
  });
});

describe('nextStick', () => {
  const G = { contentHeight: 20000, viewportHeight: 600 };

  it('stays stuck while content grows underneath a pinned view', () => {
    // scrollToEnd 之后内容继续变长：offsetY 没动，只有 contentHeight 变大。
    // 这不是用户在上滚，不能松开——否则会停在离底一千多像素处。
    const s = nextStick({ stuck: true, offsetY: 19400 }, { ...G, contentHeight: 21000, offsetY: 19400 });
    expect(s.stuck).toBe(true);
  });

  it('releases when the user actually scrolls up', () => {
    const s = nextStick({ stuck: true, offsetY: 19400 }, { ...G, offsetY: 10000 });
    expect(s.stuck).toBe(false);
  });

  it('re-sticks once the user comes back to the bottom', () => {
    const s = nextStick({ stuck: false, offsetY: 10000 }, { ...G, offsetY: 19400 });
    expect(s.stuck).toBe(true);
  });
});
