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

function safeHtmlText(html: string) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<[^>]+>/gu, '');
}

function codeLanguageLabel(info: string | undefined) {
  const language = info?.trim().split(/\s+/u, 1)[0];
  return language ? Array.from(language).slice(0, 32).join('') : null;
}

function blockTokens(tokens: Token[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];

  for (const token of tokens) {
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading;
      blocks.push({ kind: 'heading', depth: heading.depth, inlines: inlineTokens(heading.tokens) });
      continue;
    }
    if (token.type === 'paragraph' || token.type === 'text') {
      const paragraph = token as Tokens.Paragraph | Tokens.Text;
      const children = paragraph.tokens?.length
        ? paragraph.tokens
        : marked.Lexer.lexInline(paragraph.text);
      blocks.push({ kind: 'paragraph', inlines: inlineTokens(children) });
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
        header: table.header.map((cell) => inlineTokens(cell.tokens)),
        rows: table.rows.map((row) => row.map((cell) => inlineTokens(cell.tokens))),
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
export function parseMarkdownMessage(markdown: string, options: { breaks?: boolean } = {}): MarkdownBlock[] {
  return blockTokens(marked.lexer(markdown, { gfm: true, breaks: options.breaks === true }));
}
