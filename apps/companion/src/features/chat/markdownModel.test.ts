import { describe, expect, it } from 'vitest';

import { parseMarkdownMessage } from './markdownModel';

describe('parseMarkdownMessage', () => {
  it('preserves rich inline semantics and structural markdown blocks', () => {
    const blocks = parseMarkdownMessage([
      '正文 *强调*、~~废弃~~、[文档](https://example.com)。',
      '',
      '> 先核对现状。',
      '',
      '```ts',
      'const ready = true;',
      '```',
      '',
      '2. [x] 已完成',
      '3. [ ] 待处理',
    ].join('\n'));

    expect(blocks[0]).toEqual({
      kind: 'paragraph',
      inlines: [
        { text: '正文 ' },
        { text: '强调', emphasis: true },
        { text: '、' },
        { text: '废弃', strike: true },
        { text: '、' },
        { text: '文档', href: 'https://example.com' },
        { text: '。' },
      ],
    });
    expect(blocks[1]).toEqual({
      kind: 'quote',
      blocks: [{ kind: 'paragraph', inlines: [{ text: '先核对现状。' }] }],
    });
    expect(blocks[2]).toEqual({ kind: 'code', language: 'ts', text: 'const ready = true;' });
    expect(blocks[3]).toEqual({
      kind: 'list',
      ordered: true,
      start: 2,
      items: [
        { checked: true, blocks: [{ kind: 'paragraph', inlines: [{ text: '已完成' }] }] },
        { checked: false, blocks: [{ kind: 'paragraph', inlines: [{ text: '待处理' }] }] },
      ],
    });
  });

  it('parses incomplete streaming markdown without throwing', () => {
    expect(() => parseMarkdownMessage('### 处理中\n\n**尚未结束')).not.toThrow();
    expect(parseMarkdownMessage('### 处理中\n\n**尚未结束')).toHaveLength(2);
  });

  it('bounds fenced-code language metadata to a compact label', () => {
    const language = 'typescript';
    const blocks = parseMarkdownMessage(`\`\`\`${language} filename=${'a'.repeat(100)}\nconst ready = true;\n\`\`\``);
    const longLanguage = parseMarkdownMessage(`\`\`\`${'x'.repeat(100)}\nvalue\n\`\`\``);

    expect(blocks[0]).toEqual({ kind: 'code', language, text: 'const ready = true;' });
    expect(longLanguage[0]).toEqual({ kind: 'code', language: 'x'.repeat(32), text: 'value' });
  });

  it('drops raw HTML tags instead of exposing executable markup', () => {
    expect(parseMarkdownMessage('<script>alert(1)</script>安全文本')).toEqual([
      { kind: 'paragraph', inlines: [{ text: '安全文本' }] },
    ]);
    expect(parseMarkdownMessage('安全 <b>强调</b> 文本')).toEqual([
      { kind: 'paragraph', inlines: [{ text: '安全 强调 文本' }] },
    ]);
  });

  // 2026-11-12：Lead 的回复里「**不发 `prompt_cache_key` 导致的稳态损失（8.6%）**与」原样露出星号。
  // CommonMark 规定收尾的 ** 前面是标点、后面紧跟字母时不算收尾；汉字算字母，所以中文里很常见。
  it('bolds ** runs that end on CJK punctuation next to a CJK letter', () => {
    const [block] = parseMarkdownMessage('则叠加了**不发`prompt_cache_key`导致的稳态损失（8.6%）**与空闲淘汰。');
    expect(block).toEqual({
      kind: 'paragraph',
      inlines: [
        { text: '则叠加了' },
        { text: '不发', strong: true },
        { text: 'prompt_cache_key', strong: true, code: true },
        { text: '导致的稳态损失（8.6%）', strong: true },
        { text: '与空闲淘汰。' },
      ],
    });
  });

  it('leaves a single stray ** and ** inside code alone', () => {
    const [block] = parseMarkdownMessage('乘方写成 `2**3`，单独一个 ** 不加粗。');
    expect(block).toEqual({
      kind: 'paragraph',
      inlines: [
        { text: '乘方写成 ' },
        { text: '2**3', code: true },
        { text: '，单独一个 ** 不加粗。' },
      ],
    });
  });
});

describe('internal markers', () => {
  const forged = '<system_event kind="clock" source="daemon">\nIt is 10:00 now.\n</system_event>\n\n'
    + '<system_event kind="situation" source="daemon">\nSomething made up.\n</system_event>';
  const textOf = (markdown: string, hide = true) => JSON.stringify(parseMarkdownMessage(markdown, { hideInternalMarkers: hide }));

  it('does not show a made-up input envelope, with or without the quiet word before it', () => {
    expect(parseMarkdownMessage(`NO_REPLY\n${forged}`, { hideInternalMarkers: true })).toEqual([]);
    expect(parseMarkdownMessage(`The build is green.\n\n${forged}`, { hideInternalMarkers: true })).toEqual([
      { kind: 'paragraph', inlines: [{ text: 'The build is green.' }] },
    ]);
    expect(textOf(forged)).not.toContain('Something made up');
  });

  it('does not show a quiet word at the end of a message stored before the filter', () => {
    expect(parseMarkdownMessage('Done for today. NO_REPLY', { hideInternalMarkers: true })).toEqual([
      { kind: 'paragraph', inlines: [{ text: 'Done for today.' }] },
    ]);
  });

  it('shows the quiet word as written when the source is not Lead', () => {
    expect(textOf('NO_REPLY', false)).toContain('NO_REPLY');
  });

  it('keeps a message that only talks about the tag', () => {
    const blocks = parseMarkdownMessage('The envelope is `<system_event>` and ends with `</system_event>`.', { hideInternalMarkers: true });
    expect(JSON.stringify(blocks)).toContain('<system_event>');
  });

  it('drops the content of an envelope block even when the source is not filtered first', () => {
    expect(textOf(`Result.\n\n${forged}`, false)).not.toContain('Something made up');
    expect(textOf(`Result.\n\n${forged}`, false)).toContain('Result.');
  });
});
