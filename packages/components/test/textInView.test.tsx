import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Absence, RecordBlock, RecordLine, RecordTag } from '../src';
import { renderUI } from './render';

// 开发模式下，View 里的文字让整页崩溃（2026-11-09）：`<Row …> {/* 注释 */}` 里 `>` 后面的空格是一个文本节点。
// Tamagui 在开发模式下对 View 里的文本节点调 console.error，并带上整个 props；Expo 的 LogBox 序列化这些 props 时
// 遇到循环引用，整页崩溃。生产构建不报这个警告，所以只在开发模式下出现。
// 前一组测试在开发模式下渲染组件，断言 Tamagui 没有报文本节点，DOM 里 View（div）下面也没有直接的文本节点。
// 后一组测试扫源码，防止别的组件再犯：渲染测试只覆盖测试渲染到的组件，扫源码覆盖全部 JSX。

function textNodeWarnings(calls: unknown[][]): string[] {
  return calls.map(([message]) => String(message)).filter((message) => message.startsWith('Unexpected text node'));
}

// Tamagui 在 web 上把 View 渲染成 div，把 Text 渲染成 span。div 下面直接的文本节点就是 View 里的文字。
function textNodesInViews(root: HTMLElement): string[] {
  const found: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.tagName === 'DIV') found.push(JSON.stringify(node.textContent));
  }
  return found;
}

function renderInDevelopment(element: Parameters<typeof renderUI>[0]) {
  vi.stubEnv('NODE_ENV', 'development');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { container } = renderUI(element);
  return { container, warnings: textNodeWarnings(error.mock.calls) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('text inside a View in development mode', () => {
  it('RecordBlock puts every text inside Text', () => {
    const { container, warnings } = renderInDevelopment(
      <RecordBlock title="Lead 在后台处理了 2 件事 · 10:02–11:39" meta="Slack 2" toggle={{ expanded: false, onPress: () => {} }}>
        <RecordLine time="10:02" tag={<RecordTag source="Slack" label="已回复" />} text="韩梅梅问发布时间，已经回复她明天 18:00" />
      </RecordBlock>,
    );
    expect(warnings).toEqual([]);
    expect(textNodesInViews(container)).toEqual([]);
  });

  it('Absence puts every text inside Text', () => {
    const { container, warnings } = renderInDevelopment(
      <Absence label="没有回答" text="你问的「#104 那个 PR 现在还要吗？」" actions={[{ label: '重发', onPress: () => {} }]}
        details={[{ label: '原因', value: '模型超时' }]} />,
    );
    expect(warnings).toEqual([]);
    expect(textNodesInViews(container)).toEqual([]);
  });
});

// 文字守门：apps/companion 和 packages/components 的 JSX 里，文字只能放在 TEXT_TAGS 的标签里。
// 查两种子节点：JSX 文本（按 JSX 的空白规则留下来的部分，例如同一行 `>` 和 `{` 之间的空格）和字符串字面量（`{' '}`）。
// 小写的标签是 web 的 DOM 元素，里面可以放文字，不查。
// 一个组件自己把 children 放进 Text 时，把它的名字加进 TEXT_TAGS。
// 这条规则放在测试里而不是 lint 里，和 bareSpacing.test.ts 的理由一样：npm run verify 跑测试，不跑 lint。

const ROOT = join(__dirname, '..', '..', '..');
const DIRS = ['apps/companion/src', 'packages/components/src'];
const TEXT_TAGS = new Set(['Text', 'TextFrame', 'Link', 'Code']);

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(path, out);
    } else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) out.push(path);
  }
  return out;
}

// JSX 文本变成字符串的规则（和 Babel、TypeScript 的 JSX 转换一样）：每一行去掉换行两边的空白，丢掉空行，剩下的用一个空格连起来。
// 只有空白、但不带换行的文本（`<Row> {x}`）会留下一个空格。
export function jsxTextValue(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  lines.forEach((line, index) => {
    if (/[^ \t]/.test(line)) lastNonEmpty = index;
  });
  let value = '';
  lines.forEach((line, index) => {
    let trimmed = line.replace(/\t/g, ' ');
    if (index !== 0) trimmed = trimmed.replace(/^ +/, '');
    if (index !== lines.length - 1) trimmed = trimmed.replace(/ +$/, '');
    if (!trimmed) return;
    value += index === lastNonEmpty ? trimmed : `${trimmed} `;
  });
  return value;
}

function childText(node: ts.Node): string | null {
  if (ts.isJsxText(node)) return jsxTextValue(node.text) || null;
  if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
    const e = node.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text || null;
    if (ts.isTemplateExpression(e)) return e.getText();
  }
  return null;
}

// 文字所在的标签：跳过中间的 <>…</>。片段不在任何标签里时，看不出它会放进哪里，按不在 Text 里算。
function containerTag(node: ts.Node, sf: ts.SourceFile): string | null {
  let parent = node.parent;
  while (parent && ts.isJsxFragment(parent)) parent = parent.parent;
  return parent && ts.isJsxElement(parent) ? parent.openingElement.tagName.getText(sf) : null;
}

// 同一个文件里直接返回一个 Text 的小组件（`function MetaText({ children }) { return <Text …>{children}</Text>; }`）也算 Text。
function localTextTags(sf: ts.SourceFile): Set<string> {
  const tags = new Set(TEXT_TAGS);
  const returnsText = (body: ts.ConciseBody | undefined): boolean => {
    if (!body) return false;
    let result: ts.Expression | undefined = ts.isBlock(body) ? undefined : body;
    if (ts.isBlock(body)) {
      const last = body.statements.at(-1);
      result = last && ts.isReturnStatement(last) ? last.expression : undefined;
    }
    while (result && ts.isParenthesizedExpression(result)) result = result.expression;
    return !!result && ts.isJsxElement(result) && TEXT_TAGS.has(result.openingElement.tagName.getText(sf));
  };
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && returnsText(statement.body)) tags.add(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (ts.isIdentifier(declaration.name) && init && ts.isArrowFunction(init) && returnsText(init.body)) tags.add(declaration.name.text);
      }
    }
  }
  return tags;
}

// 一个文件里不在 Text 里的文字，每处一行：`行号 <标签> "文字"`。
export function textOutsideText(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const textTags = localTextTags(sf);
  const offenders: string[] = [];
  const visit = (node: ts.Node) => {
    const text = childText(node);
    if (text !== null) {
      const tag = containerTag(node, sf);
      if (tag === null || !(textTags.has(tag) || /^[a-z]/.test(tag))) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        offenders.push(`${line} <${tag ?? '>'}> ${JSON.stringify(text)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return offenders;
}

export function findTextOutsideText(root = ROOT): string[] {
  return DIRS.flatMap((dir) => walk(join(root, dir), []))
    .flatMap((file) => textOutsideText(file, readFileSync(file, 'utf8')).map((offender) => `${relative(root, file)}:${offender}`));
}

describe('text outside Text in the source', () => {
  it('turns JSX text into the string that React renders', () => {
    expect(jsxTextValue(' ')).toBe(' ');
    expect(jsxTextValue('\n        ')).toBe('');
    expect(jsxTextValue('\n  第一行\n  第二行\n')).toBe('第一行 第二行');
    expect(jsxTextValue(' · ')).toBe(' · ');
  });

  it('flags a space between a View tag and a comment on the same line', () => {
    const offenders = textOutsideText('Sample.tsx', [
      'export const A = () => <Row gap="card"> {/* 注释 */}',
      '  <Text>韩梅梅 {"·"} 李雷</Text>',
      '</Row>;',
      'export const B = () => <Column>{" "}<span> </span></Column>;',
      'export const C = () => <Row>',
      '  {/* 注释 */}',
      '  <Text>{`${1} 件`}</Text>',
      '</Row>;',
      'function Meta({ children }: { children: string }) {',
      '  return (<Text size="meta">{children}</Text>);',
      '}',
      'const Title = ({ children }: { children: string }) => <Text>{children}</Text>;',
      'export const D = () => <Row><Meta>{`${2} 条`}</Meta><Title>标题</Title><Box>{`${3} 条`}</Box></Row>;',
    ].join('\n'));
    expect(offenders).toEqual([
      '1 <Row> " "',
      '4 <Column> " "',
      '13 <Box> "`${3} 条`"',
    ]);
  });

  it('finds none in apps/companion and packages/components', () => {
    const offenders = findTextOutsideText();
    expect(offenders, `把文字放进 <Text>；组件自己把 children 放进 Text 时，把它加进 TEXT_TAGS\n${offenders.join('\n')}`).toEqual([]);
  });
});
