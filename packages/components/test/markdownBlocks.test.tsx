// GitHub 风格的 Markdown 块（2026-10-16 用户要求，参照 GitHub 的 PR 和 README 正文）：
// 代码块浅灰底、圆角、复制按钮，diff 的 + 行绿、- 行红，长行在块里横向滚动；表格是圆角卡片、表头浅灰底
// （2026-10-17 改成第四版的样式，去掉斑马纹），在块里横向滚动；
// 任务列表是勾选框。
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CodeBlock, DataTable, TaskCheckbox, Text } from '../src';
import { renderUI } from './render';

afterEach(() => vi.unstubAllGlobals());

describe('CodeBlock', () => {
  it('shows the language and copies the code', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderUI(<CodeBlock testID="code" language="ts" code={'const a = 1;\nconst b = 2;'} />);
    expect(screen.getByText('ts')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const a = 1;\nconst b = 2;'));
    expect(await screen.findByRole('button', { name: '已复制' })).toBeTruthy();
  });

  it('colors added lines green and removed lines red in a diff, like GitHub', () => {
    renderUI(<CodeBlock testID="code" language="diff" code={'--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n- const a = 1;\n+ const a = 2;\n  keep();'} />);
    expect(screen.getAllByTestId('code-diff-add')).toHaveLength(1);
    expect(screen.getAllByTestId('code-diff-del')).toHaveLength(1);
    expect(getComputedStyle(screen.getByTestId('code-diff-add')).backgroundColor).toBe('var(--c-success-wash)');
    expect(getComputedStyle(screen.getByTestId('code-diff-del')).backgroundColor).toBe('var(--c-danger-wash)');
  });

  it('scrolls long lines sideways inside the block, not the page', () => {
    renderUI(<CodeBlock testID="code" code={'x'.repeat(400)} />);
    const scroller = screen.getByTestId('code-scroll');
    expect(getComputedStyle(scroller).overflowX).toBe('auto');
    expect(getComputedStyle(screen.getByTestId('code')).backgroundColor).toBe('var(--c-surface-subtle)');
  });
});

describe('DataTable', () => {
  // 2026-10-17：第四版的样式，表头浅灰底，正文行同一底色，行之间一条细线。
  it('draws a rounded table with a tinted header and plain rows that scrolls sideways', () => {
    renderUI(
      <DataTable
        testID="table"
        columnWidths={[120, 80]}
        header={[<Text key="a">用例</Text>, <Text key="b">结果</Text>]}
        rows={[[<Text key="a">正常交接</Text>, <Text key="b">通过</Text>], [<Text key="a">撤回声明</Text>, <Text key="b">失败</Text>]]}
      />,
    );
    expect(screen.getByText('用例')).toBeTruthy();
    expect(getComputedStyle(screen.getByTestId('table-header')).backgroundColor).toBe('var(--c-surface-subtle)');
    expect(getComputedStyle(screen.getByTestId('table-row-0')).backgroundColor).toBe('var(--c-surface)');
    expect(getComputedStyle(screen.getByTestId('table-row-1')).backgroundColor).toBe('var(--c-surface)');
    expect(getComputedStyle(screen.getByTestId('table-row-1')).borderTopColor).toBe('var(--c-border-soft)');
    expect(getComputedStyle(screen.getByTestId('table-scroll')).overflowX).toBe('auto');
  });
});

// 2026-10-26 genui 基线评测：11 列的表格比卡片宽 23px，表格能横向滚动，但 macOS 平时不显示滚动条，
// 也没有别的提示，最后一列看起来被截断了（「4,052.5」只露出「4,052.」）。
// 修法：放不下时，有内容藏着的那一边画一道渐隐和一个箭头按钮，滚到头就去掉。
describe('DataTable wider than its box', () => {
  // react-native-web 的 onLayout 整个模块只建一个 ResizeObserver，第一次用到时建好，之后一直用它。
  // 所以只换一次，测试之间不清空；回调只量传给它的 entries 里的元素。
  const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', class {
      private entry: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) { this.entry.targets.push(target); }
      unobserve() {}
      disconnect() {}
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  async function renderTable(columnWidths: number[]) {
    const cells = columnWidths.map((_, index) => <Text key={index}>{`列 ${index + 1}`}</Text>);
    renderUI(<DataTable testID="table" columnWidths={columnWidths} header={cells} rows={[cells]} />);
    const scroll = screen.getByTestId('table-scroll');
    // jsdom 不排版：几何量由测试给出。卡片里能给表格的宽度是 674。
    const viewport = 674;
    const content = columnWidths.reduce((sum, width) => sum + width, 0) + 2;
    let left = 0;
    Object.defineProperty(scroll, 'scrollLeft', { configurable: true, get: () => left, set: (value: number) => { left = value; } });
    Object.defineProperty(scroll, 'scrollWidth', { configurable: true, get: () => Math.max(content, viewport) });
    Object.defineProperty(scroll, 'clientWidth', { configurable: true, get: () => viewport });
    Object.defineProperty(scroll, 'offsetWidth', { configurable: true, get: () => viewport });
    scroll.getBoundingClientRect = () => ({ top: 0, bottom: 200, left: 0, right: viewport, width: viewport, height: 200, x: 0, y: 0, toJSON: () => ({}) });
    const watching = observers.filter((entry) => entry.targets.includes(scroll));
    expect(watching.length).toBeGreaterThan(0);
    act(() => watching.forEach((entry) => entry.callback([{ target: scroll } as unknown as ResizeObserverEntry], {} as ResizeObserver)));
    // onLayout 的测量是异步的：等它把宽度交回来。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const scrollTo = (value: number) => {
      left = value;
      fireEvent.scroll(scroll);
    };
    return { scroll, scrollTo, content, viewport };
  }

  it('shows that more columns are to the right, and drops the cue when you reach the end', async () => {
    const { scrollTo, content, viewport } = await renderTable([140, 120, 120, 120, 100, 95]);
    expect(content).toBeGreaterThan(viewport);
    expect(screen.getByTestId('table-more-right')).toBeTruthy();
    expect(screen.queryByTestId('table-more-left')).toBeNull();

    scrollTo(content - viewport);
    expect(screen.queryByTestId('table-more-right')).toBeNull();
    expect(screen.getByTestId('table-more-left')).toBeTruthy();
  });

  it('scrolls one box width with the arrow, for people without a trackpad', async () => {
    await renderTable([300, 300, 300]);
    const scrollToCalls: unknown[] = [];
    const scroll = screen.getByTestId('table-scroll');
    scroll.scrollTo = ((options: unknown) => { scrollToCalls.push(options); }) as typeof scroll.scrollTo;
    fireEvent.click(screen.getByRole('button', { name: '向右看更多列' }));
    expect(scrollToCalls.length).toBe(1);
  });

  it('shows no cue when the table fits', async () => {
    await renderTable([200, 200]);
    expect(screen.queryByTestId('table-more-right')).toBeNull();
    expect(screen.queryByTestId('table-more-left')).toBeNull();
  });
});

describe('TaskCheckbox', () => {
  it('is a checked or unchecked box for screen readers too', () => {
    renderUI(<><TaskCheckbox checked testID="done" /><TaskCheckbox checked={false} testID="todo" /></>);
    expect(screen.getByTestId('done').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('todo').getAttribute('aria-checked')).toBe('false');
  });
});
