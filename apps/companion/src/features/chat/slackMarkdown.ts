import { parseMarkdownMessage, type MarkdownBlock } from './markdownModel';

// Slack 发来的原文转成 Markdown（2026-10-28 用户要求：Slack 来的消息很多时候就是 Markdown）。
// 原文已经由 engine 的 slackDisplayText 换掉了提及和链接、去掉了转义。剩下的是 Slack 自己的 mrkdwn
// （https://docs.slack.dev/messaging/formatting-message-text）和别人贴进来的 Markdown：
//   · *粗体* 在 Slack 是粗体，在 Markdown 是斜体：换成 **粗体**。~删除~ 换成 ~~删除~~。_斜体_、`代码`、```代码块```、> 引用两边一样；
//   · Slack 的列表项用「• 」「◦ 」「▪ 」开头，子项前面多 4 个空格：换成「- 」；
//   · 列表和前后的段落之间补一个空行，列表后面的一行不并进最后一项（Markdown 的懒续行）；
//   · 原文里的 < 是字面的字，不是 HTML：转义，免得被当成标签删掉。
// 段落里的单个换行是真的换行：渲染时用 breaks（见 MarkdownMessage）。代码里的字不动。
export function slackToMarkdown(text: string): string {
  return text.split('```').map((part, index) => (index % 2 === 1 ? `\n\`\`\`\n${part.replace(/^\n+|\n+$/gu, '')}\n\`\`\`\n` : prose(part))).join('');
}

/** 收起的一行：去掉标记，只留文字。 */
export function slackPlainText(text: string): string {
  return blocksText(parseMarkdownMessage(slackToMarkdown(text))).replace(/\s+/gu, ' ').trim();
}

const SLACK_BULLET = /^(\s*)[•◦▪▫‣]\s+/u;
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+/u;

type LineKind = 'blank' | 'list' | 'text';

function prose(part: string): string {
  const out: string[] = [];
  let previous: LineKind = 'blank' as LineKind;
  for (const raw of part.split('\n')) {
    const line = inline(raw.replace(SLACK_BULLET, '$1- '));
    const kind: LineKind = !line.trim() ? 'blank' : LIST_LINE.test(line) ? 'list' : /^\s/u.test(line) && previous === 'list' ? 'list' : 'text';
    if (kind !== 'blank' && previous !== 'blank' && kind !== previous) out.push('');
    out.push(line);
    previous = kind;
  }
  return out.join('\n');
}

// 行内：反引号里的代码不动，其余的字换粗体、删除线，转义 <。
function inline(line: string): string {
  return line.split(/(`[^`\n]+`)/u).map((piece, index) => (index % 2 === 1 ? piece : piece
    .replace(/</gu, '\\<')
    .replace(/(^|[^\w*\\])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/gu, '$1**$2**')
    .replace(/(^|[^\w~\\])~(?=[^\s~])([^~\n]*?[^\s~])~(?![\w~])/gu, '$1~~$2~~'))).join('');
}

function blocksText(blocks: readonly MarkdownBlock[]): string {
  return blocks.map((block) => {
    switch (block.kind) {
      case 'heading':
      case 'paragraph': return block.inlines.map((part) => part.text).join('');
      case 'list': return block.items.map((item) => blocksText(item.blocks)).join(' ');
      case 'quote': return blocksText(block.blocks);
      case 'code': return block.text;
      case 'table': return [block.header, ...block.rows].map((row) => row.map((cell) => cell.map((part) => part.text).join('')).join(' ')).join(' ');
      case 'rule': return '';
    }
  }).join(' ');
}
