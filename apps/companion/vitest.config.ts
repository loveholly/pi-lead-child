import { readdirSync, readFileSync } from 'node:fs';
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
// x!.prop 提到渲染时当依赖读，x 是 null 时整个组件在浏览器里崩掉，DOM 环境里的测试却是绿的（2026-10-23 工单 13；
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

// 测试按运行环境分两组（2026-11-09，测试提速；vitest 指南「Test Environments」「Pool」两节）。
// - 渲染界面的文件在文件头写 @vitest-environment happy-dom。它们用 vmThreads：每个 worker 只建一次 DOM 环境，每个文件在新的
//   VM 上下文里跑，模块和 window 照样每个文件一份。缺省的 forks 每个文件都要新建 DOM 环境、重新加载 react-dom 和 Tamagui，
//   整套跑时这两步占了大部分时间。
//   DOM 环境从 2026-11-10 起是 happy-dom（升级到 vitest 5 时换的）。它和以前的 DOM 实现不一样的地方，在 test/setup.ts 里补齐。
// - 其余文件在 node 环境里跑，用 threads，每个文件仍然隔离。它们不用 vmThreads：VM 上下文里 node 自带的类（例如
//   DOMException）不是这个上下文的 Error 的子类，产品代码里的 reason instanceof Error 会判断错（runtime.test.ts 取消下载那条）。
// 两组都不关隔离（isolate: false）：一半以上的文件用 vi.mock，关掉以后，前一个文件加载过的模块不会再被 mock 替换。
// 分组看文件头，不看路径，所以新文件只要照旧写环境注释就进对的组。
const SRC = fileURLToPath(new URL('./src', import.meta.url));
const DOM_FILES = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.test\.tsx?$/.test(file))
  .filter((file) => /@vitest-environment\s+happy-dom/.test(readFileSync(`${SRC}/${file}`, 'utf8')))
  .map((file) => `src/${file.split('\\').join('/')}`);

// apps/companion 的单元测试。没有这个文件时，vitest 不带配置跑：vitest 5 起不再向上一级级目录找配置文件。
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
      // react-native-svg 也一样（折线图，2026-10-30）：main 是 CJS，指向 ESM 构建，web 实现按 .web.js 取到。
      { find: /^react-native-svg$/, replacement: 'react-native-svg/lib/module/index.js' },
    ],
    extensions: ['.web.tsx', '.web.ts', '.web.mjs', '.web.js', '.tsx', '.ts', '.mjs', '.js', '.json'],
  },
  define: {
    'process.env.TAMAGUI_TARGET': JSON.stringify('web'),
    __DEV__: 'false',
  },
  test: {
    // include 写在下面两组里：组会继承这里的设置，数组是拼起来的，写在这里两组就都包含全部文件。
    exclude: [...configDefaults.exclude, 'dist/**', 'dist-*/**'],
    setupFiles: ['./test/setup.ts'],
    // 和仓库根的 vitest.config.ts 同一个理由：缺省 5 秒的超时比这些测试在忙的机器上的真实耗时还短。
    // 2026-11-06（#279）整套连跑 5 次，有 2 次各有几条渲染整个工作区的用例超时，每次是不同的用例，
    // 当时机器 8 核、负载 35 左右。这些用例空闲时只要 0.35–1.3 秒。超时是用来抓挂死的，不是量快慢的，所以放到 15 秒。
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // react-native 系的包要经过 Vite 转换，react-native 别名才对它们生效。
    server: { deps: { inline: [/@tamagui\//, /react-native-web/, /react-native-safe-area-context/, /react-native-svg/, /react-native-reanimated/, /react-native-worklets/, /expo-/, /@expo\//] } },
    projects: [
      { extends: true, test: { name: 'dom', include: DOM_FILES, pool: 'vmThreads' } },
      { extends: true, test: { name: 'node', include: ['src/**/*.test.{ts,tsx}'], exclude: DOM_FILES, pool: 'threads' } },
    ],
  },
});
