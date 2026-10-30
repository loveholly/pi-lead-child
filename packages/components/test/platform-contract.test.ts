// @vitest-environment node
// 三端 API 统一的契约：每个有原生实现的控件，web 实现（Xxx.tsx）和原生实现（Xxx.native.tsx）
// 都导出同样的组件名，并且 props 类型都来自同一个 Xxx.types.ts。类型上的一致由三遍类型检查保证
// （tsconfig.json / tsconfig.ios.json / tsconfig.android.json），这里检查文件结构，防止有人只改一端。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function nativeImplementations(): string[] {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.native.tsx') ? [path] : [];
  });
  return walk(SRC);
}

function exportedComponents(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/^export function (\w+)/gm)].map((match) => match[1]!).sort();
}

describe('one API on web, iOS and Android', () => {
  const natives = nativeImplementations();

  it('covers every native control', () => {
    const names = natives.map((file) => file.slice(SRC.length + 1));
    expect(names).toEqual(expect.arrayContaining([
      'controls/Button.native.tsx',
      'controls/TextField.native.tsx',
      'controls/Switch.native.tsx',
      'controls/SegmentedControl.native.tsx',
      'lists/ListItem.native.tsx',
      'display/TaskCard.native.tsx',
    ]));
  });

  it('has a web implementation exporting the same components for each native one', () => {
    for (const native of natives) {
      const web = native.replace(/\.native\.tsx$/, '.tsx');
      expect.soft(existsSync(web), web).toBe(true);
      expect.soft(exportedComponents(web), web).toEqual(exportedComponents(native));
    }
  });

  it('takes the props of both implementations from one shared types file', () => {
    for (const native of natives) {
      const web = native.replace(/\.native\.tsx$/, '.tsx');
      const types = native.replace(/\.native\.tsx$/, '.types.ts');
      const typesImport = `from './${types.split('/').pop()!.replace(/\.ts$/, '')}'`;
      expect.soft(existsSync(types), types).toBe(true);
      expect.soft(readFileSync(web, 'utf8'), web).toContain(typesImport);
      expect.soft(readFileSync(native, 'utf8'), native).toContain(typesImport);
    }
  });

  // 原生控件（controls/、lists/）在 iOS 和 Android 上是 SwiftUI / Compose 控件。
  // 展示类组件（display/）三端都由 Tamagui 渲染，原生实现只换掉无障碍相关的部分（例如 TaskCard 的展开按钮）。
  it('renders the native controls with Expo UI', () => {
    for (const native of natives.filter((file) => /\/(?:controls|lists)\//.test(file))) {
      expect.soft(readFileSync(native, 'utf8'), native).toMatch(/from '@expo\/ui(?:\/[\w/-]+)?'/);
    }
  });
});
