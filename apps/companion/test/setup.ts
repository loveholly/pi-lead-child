import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// findBy* 和 waitFor 缺省只等 1 秒。整套跑时机器一忙，页面的数据要好几秒才画出来：2026-11-06（#279）机器 8 核、负载 50 左右，
// 一次整套跑里 handbook 的 4 条用例同时等不到元素，单独跑都能过。和 vitest.config.ts 的 testTimeout 同一个理由，放到 5 秒。
// 只在等不到时多等，元素出现了照样马上往下走。
configure({ asyncUtilTimeout: 5_000 });

// 图标（expo-symbols 的 SymbolView）在 web 上调 expo-font 的 loadAsync。jsdom 里字体永远加载不了，
// expo-font 用 fontfaceobserver 每 25ms 轮询一次，最多 12 秒。测试文件结束、jsdom 拆掉以后，轮询读 document.hidden，
// 抛出未捕获的 TypeError，整套跑的退出码变成 1（src/testFontLoading.test.tsx）。
// 这里让 loadAsync 永远不结束：图标和以前一样停在「字体没加载」的空占位，只是不再起轮询。
vi.mock('expo-font', async (importOriginal) => ({
  ...(await importOriginal<typeof import('expo-font')>()),
  loadAsync: () => new Promise<void>(() => {}),
}));

// jsdom 没有 matchMedia。Reanimated 用它读"减弱动态效果"，Tamagui 用它算媒体查询。这里给一个都不匹配的实现。
// node 环境的测试没有 window，这段不执行。
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
