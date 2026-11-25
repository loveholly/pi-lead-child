// @ts-ignore Vitest executes source-boundary checks in Node.
import { readdirSync, readFileSync } from 'node:fs';
// @ts-ignore Vitest executes source-boundary checks in Node.
import { join, relative } from 'node:path';
// @ts-ignore Vitest executes source-boundary checks in Node.
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// 界面文字只从 *.messages.ts 的目录里取（2026-11-01，docs/i18n.md），代码里不写中文字面量。注释可以写中文。
// 下面几个文件例外：它们认的是 daemon 或 agent 写进记录的中文原文（标记、正则、键），不是给人看的文字。
const srcRoot = fileURLToPath(new URL('.', import.meta.url));

const RECOGNIZES_SERVER_TEXT = new Set([
  'features/chat/failurePresentation.ts',
  'features/chat/maintenanceNotice.ts',
  'features/chat/outagePresentation.ts',
  'features/tickets/activityKeys.ts',
  'features/workspace/model.ts',
  // 认 daemon 写进 Slack 消息正文的文件标记（工单 #529），不是界面文字。
  'features/chat/channelAttachments.ts',
  // 测试用的样例数据。
  'features/tickets/ticket66.fixture.ts',
]);

const HAN = /\p{Script=Han}/u;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry: { name: string; isDirectory(): boolean }) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.(test|messages)\.(ts|tsx)$/.test(entry.name)) return [];
    return [path];
  });
}

/** 去掉注释以后还含汉字的行。 */
export function hanLiterals(source: string): string[] {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''));
  return withoutBlocks.split('\n')
    .map((line, index) => ({ line: line.replace(/(^|[^:'"`])\/\/.*$/, '$1'), number: index + 1 }))
    .filter(({ line }) => HAN.test(line))
    .map(({ line, number }) => `${number}: ${line.trim()}`);
}

describe('i18n boundary', () => {
  it('keeps Chinese text out of the code; it lives in the message catalogs', () => {
    const violations = sourceFiles(srcRoot)
      .map((path) => relative(srcRoot, path).split('\\').join('/'))
      .filter((path) => !RECOGNIZES_SERVER_TEXT.has(path))
      .flatMap((path) => hanLiterals(readFileSync(join(srcRoot, path), 'utf8')).map((line) => `${path}:${line}`));
    expect(violations).toEqual([]);
  });

  it('finds a Chinese literal but not a Chinese comment', () => {
    expect(hanLiterals("// 注释\nconst a = 'ok'; // 行尾注释\n/* 块\n注释 */\nconst b = '中文';")).toEqual(["5: const b = '中文';"]);
  });
});
