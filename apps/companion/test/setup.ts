import { afterEach, vi } from 'vitest';

import './domShims';

// 只有 happy-dom 环境的测试文件（文件头写了 @vitest-environment happy-dom）渲染界面。node 环境的文件不用 testing-library，
// 不加载它：它连带加载 react-dom，每个文件要多花几百毫秒（2026-11-09，测试提速）。
if (typeof window !== 'undefined') {
  const { cleanup, configure } = await import('@testing-library/react');
  // findBy* 和 waitFor 缺省只等 1 秒。整套跑时机器一忙，页面的数据要好几秒才画出来：2026-11-06（#279）机器 8 核、负载 50 左右，
  // 一次整套跑里 handbook 的 4 条用例同时等不到元素，单独跑都能过。和 vitest.config.ts 的 testTimeout 同一个理由，放到 5 秒。
  // 只在等不到时多等，元素出现了照样马上往下走。
  configure({ asyncUtilTimeout: 5_000 });
  afterEach(() => cleanup());
}

// 图标（expo-symbols 的 SymbolView）在 web 上调 expo-font 的 loadAsync。测试的 DOM 里字体永远加载不了，
// expo-font 用 fontfaceobserver 每 25ms 轮询一次，最多 12 秒。测试文件结束、DOM 环境拆掉以后，轮询读 document.hidden，
// 抛出未捕获的 TypeError，整套跑的退出码变成 1（src/testFontLoading.test.tsx）。
// 这里让 loadAsync 永远不结束：图标和以前一样停在「字体没加载」的空占位，只是不再起轮询。
vi.mock('expo-font', async (importOriginal) => ({
  ...(await importOriginal<typeof import('expo-font')>()),
  loadAsync: () => new Promise<void>(() => {}),
}));
