// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { fontClass, renderUI } from '../../../test/render';
import { MarkdownMessage } from './MarkdownMessage';

describe('MarkdownMessage', () => {
  // 2026-10-16：正文和卡片同宽，宽度由所在的内容列（ConversationColumn）决定，不再单独限在 prose。
  it('takes the width of the column it sits in', () => {
    renderUI(<MarkdownMessage markdown="门都过了。验收时打开工单 #66。" />);
    const root = getComputedStyle(screen.getByTestId('markdown-message'));
    expect(root.maxWidth).not.toBe('var(--t-size-prose)');
    expect(root.width).toBe('100%');
  });

  it('renders common agent markdown without showing source markers', () => {
    const { container } = renderUI(
      <MarkdownMessage markdown={'### 执行前复核\n\n包含 **10 类 GAP** 与 `returns-core`。\n\n- 当前分支 HEAD\n- 现有测试'} />,
    );
    const text = container.textContent ?? '';

    expect(text).toContain('执行前复核');
    expect(text).toContain('10 类 GAP');
    expect(text).toContain('returns-core');
    expect(text).toContain('当前分支 HEAD');
    expect(text).not.toContain('###');
    expect(text).not.toContain('**');
    expect(text).not.toContain('- 当前分支 HEAD');
    expect(screen.getByTestId('markdown-heading-3')).toBeTruthy();
    expect(screen.getByTestId('markdown-list')).toBeTruthy();
  });

  it('renders quotes, code blocks, tasks, and safe clickable links', () => {
    const { container } = renderUI(
      <MarkdownMessage markdown={[
        '> 先核对现状。',
        '',
        '```ts',
        'const ready = true;',
        '```',
        '',
        '- [x] 已完成',
        '- [ ] 待处理',
        '',
        '[查看文档](https://example.com)',
      ].join('\n')} />,
    );
    const text = container.textContent ?? '';

    expect(text).toContain('先核对现状。');
    expect(text).toContain('const ready = true;');
    // 任务项是勾选框，不再显示 [x] 和 [ ] 文字（2026-10-16，GitHub 的样式）。
    expect(text).not.toContain('[x]');
    expect(screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(text).toContain('查看文档');
    expect(screen.getByTestId('markdown-quote')).toBeTruthy();
    expect(screen.getByTestId('markdown-code')).toBeTruthy();
    expect(screen.getByTestId('markdown-link').textContent).toBe('查看文档');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('never mounts raw HTML from an agent message', () => {
    const { container } = renderUI(
      <MarkdownMessage markdown={'<script>window.__markdownInjected = true</script>安全文本'} />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('安全文本');
  });

  it('keeps long inline code in one text fragment', () => {
    renderUI(<MarkdownMessage markdown={'与 `returns-logics-core` 保持业务等价。'} />);

    expect(screen.getAllByTestId('markdown-inline-code')).toHaveLength(1);
    expect(screen.getByTestId('markdown-inline-code').textContent).toBe('returns-logics-core');
  });

  it('keeps a long paragraph in one bounded text tree', () => {
    renderUI(<MarkdownMessage markdown={'长消息'.repeat(2_500)} />);

    expect(screen.getAllByTestId('markdown-inline-root')).toHaveLength(1);
  });

  it('preserves combined strong and emphasis styling', () => {
    renderUI(<MarkdownMessage markdown={'***粗斜体***'} />);

    expect(fontClass(screen.getByText('粗斜体'))).toBe('font_bold-italic');
  });

  it('only makes explicitly allowed link protocols interactive', () => {
    const { container } = renderUI(
      <MarkdownMessage markdown={'[安全](https://example.com) [脚本](javascript:alert%281%29) [数据](data:text/plain,test) [文件](file:///tmp/test)'} />,
    );

    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link').textContent).toBe('安全');
    expect(container.textContent).toContain('安全 脚本 数据 文件');
  });

  // 2026-10-17 用户要求：用会话方案第四版的消息样式（原来的样式太素）。
  describe('in the style of the fourth conversation design', () => {
    const inlineRoot = (element: Element) => element.querySelector('[data-testid="markdown-inline-root"]')!;

    // 2026-10-21 用户要求：正文 14（原来 15）、不设行高（原来 26），一条回复里块和块之间 8（原来 12）。
    // 数值由语义 token 决定（组件库的 tokens.test.ts 固定了它们），这里检查用的是哪个 token。
    it('sets body text in the message-body size with the font line height, and reply-block between the blocks', () => {
      renderUI(<MarkdownMessage markdown={'**结论。**\n\n## 标题\n\n已在原工单派发。\n\n- 一项\n- 两项'} />);
      const roots = screen.getAllByTestId('markdown-inline-root');
      expect(getComputedStyle(roots.at(-1)!).fontSize).toBe('var(--f-size-message-body)');
      for (const root of roots) expect(getComputedStyle(root).lineHeight).toBe('normal');
      expect(getComputedStyle(screen.getByTestId('markdown-message').firstElementChild!).gap).toBe('var(--t-space-reply-block)');
      expect(getComputedStyle(screen.getByTestId('markdown-list')).gap).toBe('var(--t-space-list-row)');
    });

    it('shows a first all-bold paragraph as the lead sentence', () => {
      renderUI(<MarkdownMessage markdown={'**PR #9789 的 SSR 冒烟没通过。**\n\n没有水合错误。'} />);
      const lead = getComputedStyle(inlineRoot(screen.getByTestId('markdown-lead')));
      expect(lead.fontSize).toBe('var(--f-size-message-lead)');
      expect(fontClass(inlineRoot(screen.getByTestId('markdown-lead')))).toBe('font_bold');
      expect(screen.getAllByTestId('markdown-lead')).toHaveLength(1);
    });

    it('treats only an all-bold first paragraph as the lead sentence', () => {
      renderUI(<MarkdownMessage markdown={'**部分**加粗的第一段。\n\n**整段加粗，但不是第一段。**'} />);
      expect(screen.queryByTestId('markdown-lead')).toBeNull();
    });

    it('draws headings without a rule under them', () => {
      renderUI(<MarkdownMessage markdown={'# 标题一\n\n## 标题二\n\n### 标题三'} />);
      for (const depth of [1, 2, 3]) {
        expect(getComputedStyle(screen.getByTestId(`markdown-heading-${depth}`)).borderBottomWidth).not.toBe('1px');
      }
    });

    it('right-aligns number columns in a monospace face and leaves text columns alone', () => {
      renderUI(<MarkdownMessage markdown={'| 页面 | HTTP | LCP |\n| --- | --- | --- |\n| home | 200 | 1640 ms |\n| rma-detail | 跳过 | — |'} />);
      // LCP 列里的「—」是占位，不影响这一列算数字；HTTP 列有「跳过」，按文字显示。
      expect(screen.getAllByTestId('markdown-table-number').map((cell) => cell.textContent)).toEqual(['1640 ms', '—']);
      expect(screen.getByText('home').closest('[data-testid="markdown-table-number"]')).toBeNull();
      expect(screen.getByText('200').closest('[data-testid="markdown-table-number"]')).toBeNull();
    });

    it('renders fenced code with a copy button, and tables that were dropped before', () => {
      renderUI(<MarkdownMessage markdown={'```ts\nconst a = 1;\n```\n\n| 用例 | 结果 |\n| --- | --- |\n| 正常交接 | **通过** |\n| 撤回声明 | 失败 |'} />);
      expect(screen.getByRole('button', { name: '复制代码' })).toBeTruthy();
      expect(screen.getByTestId('markdown-table')).toBeTruthy();
      expect(screen.getByText('正常交接')).toBeTruthy();
      expect(screen.getByText('通过')).toBeTruthy();
    });

    it('shows task items as checkboxes and indents nested lists', () => {
      renderUI(<MarkdownMessage markdown={'- [x] 正常路径\n- [ ] 恢复路径\n- 父项\n  - 子项'} />);
      const boxes = screen.getAllByRole('checkbox');
      expect(boxes.map((box) => box.getAttribute('aria-checked'))).toEqual(['true', 'false']);
      expect(screen.queryByText('[x]')).toBeNull();
      const lists = screen.getAllByTestId('markdown-list');
      expect(lists[0]!.contains(lists[1]!)).toBe(true);
    });

    it('mutes the text of a block quote', () => {
      renderUI(<MarkdownMessage markdown={'> 注意：核查还没派发。'} />);
      const quote = screen.getByTestId('markdown-quote');
      expect(getComputedStyle(quote.querySelector('[data-testid="markdown-inline-root"]')!).color).toBe('var(--c-text-secondary)');
    });
  });
});

