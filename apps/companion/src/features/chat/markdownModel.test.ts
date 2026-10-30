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
});
