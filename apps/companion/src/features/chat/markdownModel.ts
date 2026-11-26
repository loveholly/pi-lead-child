import { sanitizeLeadReply } from '@pi-lead-child/protocol';
import { marked, type Token, type Tokens } from 'marked';

export type MarkdownInline = {
  text: string;
  strong?: boolean;
  emphasis?: boolean;
  code?: boolean;
  strike?: boolean;
  href?: string;
};

export type MarkdownBlock =
  | { kind: 'heading'; depth: number; inlines: MarkdownInline[] }
  | { kind: 'paragraph'; inlines: MarkdownInline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { kind: 'quote'; blocks: MarkdownBlock[] }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'table'; align: Array<'left' | 'center' | 'right' | null>; header: MarkdownInline[][]; rows: MarkdownInline[][][] }
  | { kind: 'rule' };

export type MarkdownListItem = {
  checked: boolean | null;
  blocks: MarkdownBlock[];
};

type InlineStyle = Omit<MarkdownInline, 'text'>;

function appendInline(target: MarkdownInline[], text: string, style: InlineStyle) {
  if (!text) return;
  const previous = target[target.length - 1];
  if (
    previous
    && previous.strong === style.strong
    && previous.emphasis === style.emphasis
    && previous.code === style.code
    && previous.strike === style.strike
    && previous.href === style.href
  ) {
    previous.text += text;
    return;
  }
  target.push({ text, ...style });
}

function inlineTokens(tokens: Token[], style: InlineStyle = {}): MarkdownInline[] {
  const result: MarkdownInline[] = [];

  for (const token of tokens) {
    if (token.type === 'text' || token.type === 'escape') {
      const textToken = token as Tokens.Text | Tokens.Escape;
      if ('tokens' in textToken && textToken.tokens?.length) {
        for (const inline of inlineTokens(textToken.tokens, style)) appendInline(result, inline.text, inline);
      } else {
        appendInline(result, textToken.text, style);
      }
      continue;
    }
    if (token.type === 'strong') {
      const strong = token as Tokens.Strong;
      for (const inline of inlineTokens(strong.tokens, { ...style, strong: true })) appendInline(result, inline.text, inline);
      continue;
    }
    if (token.type === 'em') {
      const emphasis = token as Tokens.Em;
      for (const inline of inlineTokens(emphasis.tokens, { ...style, emphasis: true })) appendInline(result, inline.text, inline);
      continue;
    }
    if (token.type === 'del') {
      const deleted = token as Tokens.Del;
      for (const inline of inlineTokens(deleted.tokens, { ...style, strike: true })) appendInline(result, inline.text, inline);
      continue;
    }
    if (token.type === 'codespan') {
      appendInline(result, token.text, { ...style, code: true });
      continue;
    }
    if (token.type === 'link') {
      const link = token as Tokens.Link;
      for (const inline of inlineTokens(link.tokens, { ...style, href: link.href })) appendInline(result, inline.text, inline);
      continue;
    }
    if (token.type === 'image') {
      appendInline(result, token.text || token.href, { ...style, href: token.href });
      continue;
    }
    if (token.type === 'br') {
      appendInline(result, '\n', style);
      continue;
    }
    if (token.type === 'html') {
      appendInline(result, safeHtmlText(token.text), style);
      continue;
    }
    if ('tokens' in token && token.tokens?.length) {
      for (const inline of inlineTokens(token.tokens, style)) appendInline(result, inline.text, inline);
      continue;
    }
    if ('text' in token && typeof token.text === 'string') appendInline(result, token.text, style);
  }

  return result;
}

// The input envelopes of the daemon. A model that continues its own input writes them; what they hold is not for the reader.
const INTERNAL_TAGS = /<(system_event|user_message|untrusted_external_text)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu;

function safeHtmlText(html: string) {
  return html
    .replace(INTERNAL_TAGS, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<[^>]+>/gu, '');
}

function codeLanguageLabel(info: string | undefined) {
  const language = info?.trim().split(/\s+/u, 1)[0];
  return language ? Array.from(language).slice(0, 32).join('') : null;
}

// 补上 CommonMark 没认出来的加粗（2026-11-12）。CommonMark 规定：收尾的 ** 前面是标点、后面紧跟字母时不算收尾。
// 汉字算字母，所以「**……（8.6%）**与」这种中文里很常见的写法会原样露出星号。
// marked 认出来的加粗不受影响；这里只把它剩下的、成对的 ** 当成加粗。代码里的 ** 不算，落单的一个留着。
function repairStrong(inlines: MarkdownInline[]): MarkdownInline[] {
  const markers = inlines.reduce((count, inline) => (inline.code ? count : count + inline.text.split('**').length - 1), 0);
  if (markers < 2) return inlines;
  let pairable = markers - (markers % 2);
  let strong = false;
  const result: MarkdownInline[] = [];
  for (const { text, ...style } of inlines) {
    const styled = () => ({ ...style, strong: style.strong || strong || undefined });
    if (style.code) {
      appendInline(result, text, styled());
      continue;
    }
    const parts = text.split('**');
    parts.forEach((part, index) => {
      if (index > 0) {
        if (pairable > 0) {
          pairable -= 1;
          strong = !strong;
        } else {
          appendInline(result, '**', styled());
        }
      }
      appendInline(result, part, styled());
    });
  }
  // 去掉值是 undefined 的样式键，和 inlineTokens 的输出一样只带用到的键。
  return result.map((inline) => Object.fromEntries(Object.entries(inline).filter(([, value]) => value !== undefined)) as MarkdownInline);
}

function inlines(tokens: Token[]): MarkdownInline[] {
  return repairStrong(inlineTokens(tokens));
}

function blockTokens(tokens: Token[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];

  for (const token of tokens) {
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading;
      blocks.push({ kind: 'heading', depth: heading.depth, inlines: inlines(heading.tokens) });
      continue;
    }
    if (token.type === 'paragraph' || token.type === 'text') {
      const paragraph = token as Tokens.Paragraph | Tokens.Text;
      const children = paragraph.tokens?.length
        ? paragraph.tokens
        : marked.Lexer.lexInline(paragraph.text);
      blocks.push({ kind: 'paragraph', inlines: inlines(children) });
      continue;
    }
    if (token.type === 'list') {
      const list = token as Tokens.List;
      blocks.push({
        kind: 'list',
        ordered: list.ordered,
        start: typeof list.start === 'number' ? list.start : 1,
        items: list.items.map((item: Tokens.ListItem) => ({
          checked: item.task ? item.checked ?? false : null,
          blocks: blockTokens(item.tokens),
        })),
      });
      continue;
    }
    if (token.type === 'blockquote') {
      const quote = token as Tokens.Blockquote;
      blocks.push({ kind: 'quote', blocks: blockTokens(quote.tokens) });
      continue;
    }
    if (token.type === 'code') {
      blocks.push({ kind: 'code', language: codeLanguageLabel(token.lang), text: token.text });
      continue;
    }
    if (token.type === 'hr') {
      blocks.push({ kind: 'rule' });
      continue;
    }
    // 表格（GFM）。以前不认识，整张表都丢了（2026-10-16）。
    if (token.type === 'table') {
      const table = token as Tokens.Table;
      blocks.push({
        kind: 'table',
        align: table.align.map((value) => value ?? null),
        header: table.header.map((cell) => inlines(cell.tokens)),
        rows: table.rows.map((row) => row.map((cell) => inlines(cell.tokens))),
      });
      continue;
    }
    if (token.type === 'html') {
      const text = safeHtmlText(token.text);
      if (text) blocks.push({ kind: 'paragraph', inlines: [{ text }] });
    }
  }

  return blocks;
}

// breaks：段落里的单个换行当真的换行（Slack 这样的来源，slackMarkdown.ts）。Lead 的回复不用。
// hideInternalMarkers: the text is something Lead or an agent wrote. The quiet word at its start or end and a made-up
// input envelope (a line that starts with <system_event> and the rest) are not shown, also in messages that were stored
// before the daemon filtered them. The rule is the daemon's own (protocol's reply-guard.ts). Text of someone else, such as
// a Slack message, is shown as it was written.
export function parseMarkdownMessage(
  markdown: string,
  options: { breaks?: boolean; hideInternalMarkers?: boolean } = {},
): MarkdownBlock[] {
  const source = options.hideInternalMarkers ? sanitizeLeadReply(markdown).text : markdown;
  return blockTokens(marked.lexer(source, { gfm: true, breaks: options.breaks === true }));
}

// 一块的纯文字（手机上整段引用时用，设计规范 P17.10）：去掉格式，列表一项一行，表格一格一个空格。
export function markdownBlockText(block: MarkdownBlock): string {
  const inlines = (items: MarkdownInline[]) => items.map((inline) => inline.text).join('');
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
      return inlines(block.inlines);
    case 'list':
      return block.items.map((item) => item.blocks.map(markdownBlockText).join('\n')).join('\n');
    case 'quote':
      return block.blocks.map(markdownBlockText).join('\n');
    case 'code':
      return block.text;
    case 'table':
      return [block.header, ...block.rows].map((row) => row.map(inlines).join(' ')).join('\n');
    case 'rule':
      return '';
  }
}
