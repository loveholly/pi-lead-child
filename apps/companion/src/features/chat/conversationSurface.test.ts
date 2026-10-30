// @vitest-environment jsdom
// 会话的底色和文字（方案 B）：会话栏是白底，是窗口里最亮的一层。Lead 的回复直接排在白底上，不加气泡；
// 你的消息是浅灰气泡。主会话和工单对话用同一个气泡。正文和元信息（谁、几点）的对比度都到 WCAG AA。
// @ts-ignore Vitest executes source checks in Node.
import { readFileSync } from 'node:fs';

import { palette, type ColorToken } from '@pi-lead-child/components';
import { describe, expect, it } from 'vitest';

// WCAG 2.x 的相对亮度和对比度。
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(foreground: ColorToken, background: ColorToken): number {
  const [light, dark] = [luminance(palette[foreground]), luminance(palette[background])].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('conversation surface', () => {
  it('keeps body and meta text at WCAG AA (4.5:1) on every surface in the conversation', () => {
    const pairs: Array<[string, ColorToken, ColorToken]> = [
      ['Lead 的回复', 'text', 'surface'],
      ['你的消息', 'text', 'surface-muted'],
      ['系统通知', 'text', 'accent-wash'],
      ['发送者和时间', 'text-secondary', 'surface'],
      ['工单消息回执和进展通知里的说明', 'text-secondary', 'surface-subtle'],
      ['系统通知里的说明', 'text-secondary', 'accent-wash'],
      ['介入卡片里的说明', 'text-secondary', 'danger-surface'],
      ['处理完的介入卡片里的说明', 'text-secondary', 'success-surface'],
      ['白底上的链接和按钮文字', 'accent', 'surface'],
      ['强调色按钮上的白字', 'surface', 'accent'],
      ['失败卡片的说明（红）', 'danger-dark', 'surface'],
      ['失败卡片的说明（黄）、降级时顶栏的小字', 'warning-dark', 'surface'],
      ['认证、配置失败时顶栏的小字', 'danger-dark', 'surface'],
    ];
    for (const [label, foreground, background] of pairs) {
      expect.soft(contrast(foreground, background), `${label}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('writes conversation text in tones that pass AA, not muted or faint', () => {
    expect(source('./LeadConversation.tsx')).not.toMatch(/<Text\b[^>]*\btone="(?:muted|faint)"/);
    expect(source('./CheckpointCard.tsx')).not.toMatch(/<Text\b[^>]*\btone="(?:muted|faint)"/);
    expect(source('./InterventionCard.tsx')).not.toMatch(/<Text\b[^>]*\btone="(?:muted|faint)"/);
    expect(source('./FailureCard.tsx')).not.toMatch(/<Text\b[^>]*\btone="(?:muted|faint)"/);
    // 顶栏 Lead 名字下面的小字（在线时的巡检时间、离线、降级）。
    expect(source('../../components/LeadIdentity.tsx')).not.toMatch(/'muted'|"muted"/);
  });

  it('puts both chats on the white surface, on desktop and on the phone', () => {
    expect(source('./LeadConversation.tsx')).toContain('<KeyboardArea testID="lead-conversation" bg="surface">');
    // 手机上单独打开的工单详情以前是灰底，浅灰气泡在上面看不出来。
    expect(source('../tickets/TicketThread.tsx')).toContain('<Column testID="ticket-thread" flex={1} minW={0} bg="surface">');
  });

  it('draws your messages in the shared light bubble in both chats and leaves agent replies unboxed', () => {
    const lead = source('./LeadConversation.tsx');
    const ticket = source('../tickets/TicketConversation.tsx');
    for (const file of [lead, ticket]) {
      expect(file).toMatch(/<MessageBubble\b/);
      expect(file).not.toMatch(/\bbg(?:: |=)['"]text['"]/);
    }
    // 气泡是浅底，里面的文字用主文字色，不再是反白字。
    expect(source('./MessagePartView.tsx')).not.toMatch(/<Text\b[^>]*\btone="inverse"/);
    // 工单对话的长回复可以折起来（工单详情复核 P2-5），折起来的里面还是同一个 MarkdownMessage。
    expect(ticket).toMatch(/renderReply=\{\(reply\) => reply\s*\? <FoldableReply markdown=\{reply\}/);
    expect(ticket).toContain('<MarkdownMessage markdown={markdown} />');
  });
});
