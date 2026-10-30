// @ts-ignore Vitest executes source-boundary checks in Node.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
// @ts-ignore Vitest executes source-boundary checks in Node.
import { join, relative } from 'node:path';
// @ts-ignore Vitest executes source-boundary checks in Node.
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// 应用的界面只从 @pi-lead-child/components 引入。布局、文字、控件、图标、动画和主题都在组件库里，
// 应用不直接用 react-native、Expo UI、Tamagui 或样式表手写界面。

const srcRoot = fileURLToPath(new URL('.', import.meta.url));
const appRoot = fileURLToPath(new URL('..', import.meta.url));

// 这些包提供界面原语。只有组件库可以直接引入它们。
const UI_PRIMITIVE_PACKAGES = [
  /^react-native$/,
  /^react-native-web$/,
  /^react-native-reanimated$/,
  /^react-native-safe-area-context$/,
  /^react-native-unistyles$/,
  /^@expo\/ui(\/.*)?$/,
  /^expo-symbols$/,
  /^expo-glass-effect$/,
  /^tamagui$/,
  /^@tamagui\//,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry: { name: string; isDirectory(): boolean }) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return [];
    return [path];
  });
}

function importedModules(source: string): string[] {
  const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]!);
  const bare = [...source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map((match) => match[1]!);
  return [...specifiers, ...bare];
}

const files = sourceFiles(srcRoot).map((path) => ({
  path: relative(appRoot, path),
  source: readFileSync(path, 'utf8'),
}));

describe('web UI boundary', () => {
  it('imports UI primitives only through @pi-lead-child/components', () => {
    const violations = files.flatMap(({ path, source }) => importedModules(source)
      .filter((specifier) => UI_PRIMITIVE_PACKAGES.some((pattern) => pattern.test(specifier)))
      .map((specifier) => `${path} imports ${specifier}`));

    expect(violations).toEqual([]);
  });

  it('has no hand-written style sheets or inline style objects', () => {
    const violations = files.flatMap(({ path, source }) => {
      const found: string[] = [];
      if (/\bStyleSheet\b/.test(source)) found.push(`${path} uses StyleSheet`);
      for (const match of source.matchAll(/<([A-Za-z.]+)\b[^<>]*?\sstyle=\{/g)) {
        // 相机预览是设备视图，不属于组件库；它只接受 RN style。
        if (path.endsWith('PairingScanner.tsx') && match[1] === 'CameraView') continue;
        found.push(`${path} passes style to <${match[1]}>`);
      }
      return found;
    });

    expect(violations).toEqual([]);
  });

  it('renders no raw DOM elements outside the HTML document shell', () => {
    const violations = files
      .filter(({ path }) => !path.endsWith('+html.tsx'))
      .flatMap(({ path, source }) => [...source.matchAll(/<(div|span|p|a|button|input|textarea|img|svg|ul|li|section)[\s>/]/g)]
        .map((match) => `${path} renders <${match[1]}>`));

    expect(violations).toEqual([]);
  });

  it('removed the hand-written design layer', () => {
    for (const path of [
      'src/design',
      'src/unistyles.ts',
      'src/unistyles.web.ts',
      'src/unistyles.native.ts',
      'src/components/AppIcon.tsx',
      'src/components/NativeActionButton.tsx',
      'src/components/UiAlignment.tsx',
    ]) {
      expect.soft(existsSync(join(appRoot, path)), path).toBe(false);
    }
    const manifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(manifest.dependencies['@pi-lead-child/components']).toBe('*');
    expect(manifest.dependencies['react-native-unistyles']).toBeUndefined();
  });
});
