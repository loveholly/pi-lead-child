import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom 没有 matchMedia。Reanimated 用它读"减弱动态效果"，Tamagui 用它算媒体查询。这里给一个都不匹配的实现。
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// jsdom 的 requestAnimationFrame 传给回调的时间从窗口创建时算起，Reanimated 的动画起点用的是 performance.now()。
// 两个时钟差几秒，动画按负的时间算，永远播不完。这里让回调拿到 performance.now()，和浏览器里一样是同一个时钟。
if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
  const requestFrame = window.requestAnimationFrame.bind(window);
  const sameClock = (callback: FrameRequestCallback) => requestFrame(() => callback(performance.now()));
  window.requestAnimationFrame = sameClock;
  globalThis.requestAnimationFrame = sameClock;
}

afterEach(() => cleanup());
