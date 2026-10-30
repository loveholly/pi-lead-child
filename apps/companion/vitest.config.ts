import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig, type Plugin } from 'vitest/config';

// @expo-google-fonts/* 用 require('./x.ttf') 导出字体文件。Metro 把它当资源处理，node 会把 .ttf 当 JS 解析而失败。
// 测试不加载字体，这里把这些 require 换成文件名字符串。
const fontFilesAsNames: Plugin = {
  name: 'font-files-as-names',
  enforce: 'pre',
  transform(code, id) {
    if (!id.includes('/@expo-google-fonts/')) return null;
    return code.replace(/require\((['"])([^'"]+\.ttf)\1\)/g, (_match, _quote, file: string) => JSON.stringify(file));
  },
};

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

// 网页包（Metro）开着 React Compiler（app.json 的 experiments.reactCompiler），vitest 平时不开。编译器会把闭包里的
// x!.prop 提到渲染时当依赖读，x 是 null 时整个组件在浏览器里崩掉，jsdom 的测试却是绿的（2026-10-23 工单 13；
// 2026-10-29 设置 → 模型的「接入服务商」「添加决策模型」点了就报错）。这里列出的文件在测试里也过一遍编译器，
// 和浏览器里跑的是同一份代码。只编译组件本身，类型和 JSX 留给后面的转换。
const COMPILED_IN_TESTS = [
  '/src/features/settings/ModelLibrary.tsx',
  '/src/features/settings/ModelSection.tsx',
  '/src/features/settings/ModelPicker.tsx',
];
// @babel/core 没有类型声明（仓库里没有 @types/babel__core）：用 require 取，只声明这里用到的那一个函数。
const { transformAsync } = createRequire(import.meta.url)('@babel/core') as {
  transformAsync: (code: string, options: Record<string, unknown>) => Promise<{ code?: string | null; map?: unknown } | null>;
};
const reactCompilerForListedFiles: Plugin = {
  name: 'react-compiler-for-listed-files',
  enforce: 'pre',
  async transform(code, id) {
    const file = id.split('?')[0]!;
    if (!COMPILED_IN_TESTS.some((suffix) => file.endsWith(suffix))) return null;
    const result = await transformAsync(code, {
      filename: file,
      babelrc: false,
      configFile: false,
      parserOpts: { plugins: ['typescript', 'jsx'] },
      plugins: [['babel-plugin-react-compiler', { panicThreshold: 'all_errors' }]],
      sourceMaps: true,
    });
    return result?.code ? { code: result.code, map: (result.map ?? null) as never } : null;
  },
};

// apps/companion 的单元测试。没有这个文件时，vitest 会向上找到仓库根的配置，而根配置只跑后端各包的测试。
// 界面模块经过 @pi-lead-child/components 引入 react-native。这里和组件库的测试一样，
// 把 react-native 换成 react-native-web，Tamagui 以 web 为目标，渲染路径和浏览器里的 web 包相同。
export default defineConfig({
  plugins: [fontFilesAsNames, reanimatedWebStyles, reactCompilerForListedFiles],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${fileURLToPath(new URL('./src', import.meta.url))}/` },
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
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: [...configDefaults.exclude, 'dist/**', 'dist-*/**'],
    setupFiles: ['./test/setup.ts'],
    // react-native 系的包要经过 Vite 转换，react-native 别名才对它们生效。
    server: { deps: { inline: [/@tamagui\//, /react-native-web/, /react-native-safe-area-context/, /react-native-reanimated/, /react-native-worklets/, /expo-/, /@expo\//] } },
  },
});
