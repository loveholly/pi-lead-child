import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

import './domShims';

// 图标（expo-symbols 的 SymbolView）在 web 上调 expo-font 的 loadAsync。测试的 DOM 里字体永远加载不了，
// expo-font 用 fontfaceobserver 每 25ms 轮询一次，最多 12 秒。测试文件结束、DOM 环境拆掉以后，轮询读 document.hidden，
// 抛出未捕获的 TypeError，整套跑的退出码变成 1（test/fontLoading.test.tsx）。
// 这里让 loadAsync 永远不结束：图标和以前一样停在「字体没加载」的空占位，只是不再起轮询。
vi.mock('expo-font', async (importOriginal) => ({
  ...(await importOriginal<typeof import('expo-font')>()),
  loadAsync: () => new Promise<void>(() => {}),
}));

afterEach(() => cleanup());
