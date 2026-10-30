import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// 裸数字守门（2026-10-22）：apps/companion 和 packages/components 的 JSX 里，间距属性和 Text 的 size、leading
// 不能写数字，要用语义 token（README「语义间距和语义字号」）。有意保留数字的地方，同一行或上一行写
// `spacing-exempt: 原因`（行尾 `// …` 或单独一行 `{/* … */}`）。0 不算：它表示没有间距。
// 这条规则放在测试里而不是 ESLint 里，因为 npm run verify 跑测试，不跑 lint。

const ROOT = join(__dirname, '..', '..', '..');
const DIRS = ['apps/companion/src', 'packages/components/src'];
const SPACE_PROPS = new Set(['gap', 'rowGap', 'columnGap', 'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr']);
const TEXT_TAGS = /^(Text|TextFrame|Link|Code)$/;
const EXEMPT = /spacing-exempt:/;

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(path, out);
    } else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) out.push(path);
  }
  return out;
}

function isBareNumber(init: ts.JsxAttribute['initializer']): boolean {
  if (!init) return false;
  if (ts.isStringLiteral(init)) return /^-?\d+(\.\d+)?$/.test(init.text) && Number(init.text) !== 0;
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression;
    if (ts.isNumericLiteral(e)) return Number(e.text) !== 0;
    if (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand)) return true;
  }
  return false;
}

export function findBareSpacing(root = ROOT): string[] {
  const offenders: string[] = [];
  for (const dir of DIRS) {
    for (const file of walk(join(root, dir), [])) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(sf);
          for (const attr of node.attributes.properties) {
            if (!ts.isJsxAttribute(attr)) continue;
            const name = attr.name.getText(sf);
            const text = TEXT_TAGS.test(tag) && (name === 'size' || name === 'leading');
            if (!SPACE_PROPS.has(name) && !text) continue;
            if (!isBareNumber(attr.initializer)) continue;
            const line = sf.getLineAndCharacterOfPosition(attr.getStart(sf)).line;
            const tagLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
            const exempt = [line, line - 1, tagLine, tagLine - 1].some((i) => i >= 0 && EXEMPT.test(lines[i] ?? ''));
            if (!exempt) offenders.push(`${relative(root, file)}:${line + 1} ${name}=${attr.initializer?.getText(sf)}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return offenders;
}

describe('bare spacing numbers', () => {
  it('finds none outside spacing-exempt lines', () => {
    const offenders = findBareSpacing();
    expect(offenders, `用语义 token，或在同一行写 spacing-exempt: 原因\n${offenders.join('\n')}`).toEqual([]);
  });
});
