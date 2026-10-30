import { configDefaults, defineConfig, type Plugin } from 'vitest/config';

// Reanimated 在 web 上用 require 取 react-native-web 的三个样式函数（js-reanimated/webUtils.web.js）。
// vitest 按 ESM 转换它，没有 require，三个函数都取不到：动画样式写不到元素上，动画中新挂载的动画元素还会报错。
// 这里把这个文件换成同样三个函数的 ESM 导出，和浏览器里的行为一致（2026-10-16，对话坞的展开动画）。
const reanimatedWebStyles: Plugin = {
  name: 'reanimated-web-styles',
  enforce: 'pre',
  transform(_code, id) {
    if (!/\/react-native-reanimated\/.*\/js-reanimated\/webUtils\.web\.[jt]s$/.test(id.split('?')[0]!)) return null;
    return [
      "export { default as createReactDOMStyle } from 'react-native-web/dist/exports/StyleSheet/compiler/createReactDOMStyle';",
      "export { createTextShadowValue, createTransformValue } from 'react-native-web/dist/exports/StyleSheet/preprocess';",
    ].join('\n');
  },
};

// 组件测试在 jsdom 里渲染 web 实现，和浏览器里 Metro 打出的 web 包走同一条路径：
// react-native 换成 react-native-web，Tamagui 以 web 为目标。原生实现由 tsconfig.native.json 做类型检查。
export default defineConfig({
  plugins: [reanimatedWebStyles],
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: 'react-native-web' },
      // 它的 main 是 CJS，里面的 require('react-native') 绕过上面的别名。指向它的 ESM 构建。
      { find: /^react-native-safe-area-context$/, replacement: 'react-native-safe-area-context/lib/module/index.js' },
    ],
    extensions: ['.web.tsx', '.web.ts', '.web.mjs', '.web.js', '.tsx', '.ts', '.mjs', '.js', '.json'],
  },
  define: {
    'process.env.TAMAGUI_TARGET': JSON.stringify('web'),
    __DEV__: 'false',
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: [...configDefaults.exclude],
    setupFiles: ['./test/setup.ts'],
    // react-native 系的包要经过 Vite 转换，react-native 别名才对它们生效。
    server: { deps: { inline: [/@tamagui\//, /react-native-web/, /react-native-safe-area-context/, /react-native-reanimated/, /react-native-worklets/, /expo-/, /@expo\//] } },
  },
});
