// @vitest-environment happy-dom
// 外来消息卡里的图片、文件和每条消息的 Slack 链接（工单 #529，视觉稿「Slack 消息卡：改前 / 改后」）：
//   · 图片画成 72 的缩略图，跟着各自的消息，一条最多 4 张，第 4 格盖「+N」；不再写「[图片 …，文件编号 …]」。
//   · 点缩略图打开预览：左右切换，点黑底关上，下面「1 / 3」和「在 Slack 打开」。
//   · 取不到的图片退回原来的文字标记，卡的其余部分照常。
//   · 正文和会话里的普通消息一样大；时间是浅灰小字和 Slack 链接；拿不到链接时只是字。
//   · 不是图片的文件是「图标 + 文件名」的小标签，点了在 Slack 打开。收起的卡上最新一条的图是 36 的小图，点了照样能看。
import type { ChannelCardDto } from '@pi-lead-child/protocol';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cssVar, renderUI } from '../../../test/render';
import { ChannelMessageCard } from './ChannelMessageCard';
import { thumbsThatFit } from './ChannelMessageMedia';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});

const openURL = vi.hoisted(() => vi.fn());
vi.mock('@pi-lead-child/components', async (original) => ({ ...(await original<object>()), openURL }));

afterEach(() => {
  cleanup();
  openURL.mockReset();
});

const LINK = 'https://acme.slack.com/archives/C0DEMO/p1700000000000100';
const THREAD_LINK = 'https://acme.slack.com/archives/C0DEMO/p1700000500000200?thread_ts=1700000000.000100&cid=C0DEMO';
const image = (id: string, name = 'image.png') => `[图片 ${name}，文件编号 slack:${id}]`;

function card(recent: NonNullable<ChannelCardDto['recent']>, overrides: Partial<ChannelCardDto> = {}): ChannelCardDto {
  return {
    id: 7, version: 3, source: 'slack', sourceLabel: 'Slack', objectKey: 'slack:C0DEMO:1700000000.000100', laneLabel: '#release 里的讨论',
    sender: { id: 'U0ALEX', name: 'Alex Chen', trust: 'colleague' }, excerpt: recent.at(-1)!.text, messageCount: recent.length,
    recent, delivery: 'card', state: 'open', draft: null, gate: null, lookup: null, handling: null,
    sentText: null, snoozedUntil: null, revokeUntil: null, resolvedAt: null,
    actions: ['send_edited', 'reply_myself', 'snooze', 'dismiss'],
    createdAt: '2026-11-25T02:00:00.000Z', updatedAt: '2026-11-25T02:31:00.000Z',
    ...overrides,
  };
}

const released = card([
  { at: '2026-11-25T02:02:00.000Z', text: `前后端都发布了 CC @Sam Lee\n${image('F0DEMO0001')}\n${image('F0DEMO0002')}`, url: LINK },
  { at: '2026-11-25T02:25:00.000Z', text: image('F0DEMO0003', 'stats.png'), url: THREAD_LINK },
]);

// 假的取图：每个编号一张 PNG；failing 里的编号取不到。
function loader(failing: string[] = []) {
  return vi.fn(async (fileId: string) => {
    if (failing.includes(fileId)) throw new Error('404 not_found');
    return { mimeType: 'image/png', data: btoa(fileId) };
  });
}

async function openCard() {
  fireEvent.click(screen.getByTestId('surface-disclosure-channel-card-7-summary'));
  return screen.findByTestId('channel-card-7-panel');
}

describe('images in a channel card', () => {
  it('shows each message\'s pictures as thumbnails under it, instead of the file markers', async () => {
    const load = loader();
    renderUI(<ChannelMessageCard card={released} onAction={vi.fn()} loadImage={load} />);
    await openCard();
    await waitFor(() => expect(screen.getByTestId('channel-card-7-images-1-0').querySelector('img')).toBeTruthy());
    expect(within(screen.getByTestId('channel-card-7-images-0')).getAllByRole('img')).toHaveLength(2);
    expect(within(screen.getByTestId('channel-card-7-images-1')).getAllByRole('img')).toHaveLength(1);
    const bubble = screen.getByTestId('channel-card-7-messages');
    expect(bubble.textContent).toContain('前后端都发布了');
    expect(bubble.textContent).not.toContain('文件编号');
    expect(screen.getByTestId('channel-card-7-latest').textContent).not.toContain('文件编号');
    // 同一个文件编号只取一次。
    expect(load.mock.calls.map(([fileId]) => fileId).sort()).toEqual(['slack:F0DEMO0001', 'slack:F0DEMO0002', 'slack:F0DEMO0003']);
  });

  it('shows at most four thumbnails for one message, with +N on the fourth, and the preview reaches all of them', async () => {
    const many = card([{ at: '2026-11-25T07:40:00.000Z', text: ['各环境的截图都在这', ...[1, 2, 3, 4, 5, 6].map((n) => image(`F0SHOT${n}`, `env-${n}.png`))].join('\n'), url: LINK }]);
    renderUI(<ChannelMessageCard card={many} onAction={vi.fn()} loadImage={loader()} />);
    await openCard();
    const row = screen.getByTestId('channel-card-7-images-0');
    await waitFor(() => expect(within(row).getAllByRole('img')).toHaveLength(4));
    expect(screen.getByTestId('channel-card-7-images-0-3').textContent).toBe('+2');
    expect(screen.getByTestId('channel-card-7-images-0-2').textContent).toBe('');
    fireEvent.click(screen.getByTestId('channel-card-7-images-0-3-open'));
    const preview = await screen.findByTestId('channel-card-7-preview');
    expect(within(preview).getByTestId('channel-card-7-preview-count').textContent).toBe('4 / 6');
    fireEvent.click(within(preview).getByTestId('channel-card-7-preview-next'));
    fireEvent.click(within(preview).getByTestId('channel-card-7-preview-next'));
    expect(within(preview).getByTestId('channel-card-7-preview-count').textContent).toBe('6 / 6');
    expect(preview.textContent).toContain('env-6.png');
  });

  it('opens a preview with arrows, the position, Open in Slack, and closes on the backdrop', async () => {
    renderUI(<ChannelMessageCard card={released} onAction={vi.fn()} loadImage={loader()} />);
    await openCard();
    await waitFor(() => expect(screen.getByTestId('channel-card-7-images-0-0').querySelector('img')).toBeTruthy());
    fireEvent.click(screen.getByTestId('channel-card-7-images-0-1-open'));
    const preview = await screen.findByTestId('channel-card-7-preview');
    expect(within(preview).getByTestId('channel-card-7-preview-count').textContent).toBe('2 / 2');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })); });
    expect(within(preview).getByTestId('channel-card-7-preview-count').textContent).toBe('1 / 2');
    fireEvent.click(within(preview).getByTestId('channel-card-7-preview-action-slack'));
    expect(openURL).toHaveBeenCalledWith(LINK);
    // 点图片本身不关，点外面的黑底关上。
    fireEvent.click(within(preview).getByTestId('channel-card-7-preview-page-0-image'));
    expect(screen.getByTestId('channel-card-7-preview')).toBeTruthy();
    fireEvent.click(within(preview).getByTestId('channel-card-7-preview-page-0-backdrop'));
    await waitFor(() => expect(screen.queryByTestId('channel-card-7-preview')).toBeNull());
    // 卡还在，浮层也还开着。
    expect(screen.getByTestId('channel-card-7-panel')).toBeTruthy();
  });

  it('falls back to the original marker for a picture it cannot load, and the rest of the card works', async () => {
    const onAction = vi.fn(async () => {});
    renderUI(<ChannelMessageCard card={released} onAction={onAction} loadImage={loader(['slack:F0DEMO0002'])} />);
    await openCard();
    await waitFor(() => expect(screen.getByTestId('channel-card-7-messages').textContent).toContain(image('F0DEMO0002')));
    const bubble = screen.getByTestId('channel-card-7-messages');
    expect(bubble.textContent).not.toContain(image('F0DEMO0001'));
    await waitFor(() => expect(within(screen.getByTestId('channel-card-7-images-0')).getAllByRole('img')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('channel-card-7-reply_myself-p'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('reply_myself'));
  });

  it('keeps all markers as text when the card cannot load pictures (an older daemon)', async () => {
    renderUI(<ChannelMessageCard card={released} onAction={vi.fn()} />);
    await openCard();
    const bubble = screen.getByTestId('channel-card-7-messages');
    expect(bubble.textContent).toContain(image('F0DEMO0001'));
    expect(bubble.textContent).toContain(image('F0DEMO0003', 'stats.png'));
    expect(screen.queryByTestId('channel-card-7-images-0')).toBeNull();
  });

  it('shows the newest message\'s pictures at 36 on the folded card, and opens them without opening the card', async () => {
    renderUI(<ChannelMessageCard card={released} onAction={vi.fn()} loadImage={loader()} />);
    const latest = screen.getByTestId('channel-card-7-latest');
    await waitFor(() => expect(within(latest).getAllByRole('img')).toHaveLength(1));
    expect(latest.textContent).toContain('[1 image]');
    expect(latest.textContent).not.toContain('文件编号');
    fireEvent.click(screen.getByTestId('channel-card-7-latest-images-0-open'));
    const preview = await screen.findByTestId('channel-card-7-preview');
    expect(preview.textContent).toContain('stats.png');
    expect(screen.queryByTestId('channel-card-7-panel')).toBeNull();
  });
});

describe('text, time and files in a channel card', () => {
  it('sets the message text in the size of a normal conversation message', async () => {
    renderUI(<ChannelMessageCard card={released} onAction={vi.fn()} loadImage={loader()} />);
    await openCard();
    const root = within(screen.getByTestId('channel-card-7-messages')).getAllByTestId('markdown-inline-root')[0]!;
    expect(getComputedStyle(root).fontSize).toBe(cssVar('--f-size-message-body', root));
  });

  it('makes each time a link to its message in Slack, and only plain text without a link', async () => {
    const mixed = card([
      { at: '2026-11-25T02:02:00.000Z', text: '有链接', url: THREAD_LINK },
      { at: '2026-11-25T02:25:00.000Z', text: '没有链接' },
    ]);
    renderUI(<ChannelMessageCard card={mixed} onAction={vi.fn()} />);
    await openCard();
    const linked = screen.getByTestId('channel-card-7-time-0');
    expect(linked.getAttribute('role')).toBe('link');
    fireEvent.click(linked);
    expect(openURL).toHaveBeenCalledWith(THREAD_LINK);
    const plain = screen.getByTestId('channel-card-7-time-1');
    expect(plain.getAttribute('role')).toBeNull();
    fireEvent.click(plain);
    expect(openURL).toHaveBeenCalledTimes(1);
    // 不是 http(s) 的链接不当链接。
    cleanup();
    renderUI(<ChannelMessageCard card={card([{ at: '2026-11-25T02:02:00.000Z', text: 'x', url: 'javascript:alert(1)' }])} onAction={vi.fn()} />);
    expect(screen.getByTestId('channel-card-7-latest-time').getAttribute('role')).toBeNull();
  });

  it('shows a file that is not a picture as a small tag that opens the message in Slack', async () => {
    const report = card([{ at: '2026-11-25T03:20:00.000Z', text: '这个报表对一下\n[文件 report.pdf，application/pdf，文件编号 slack:F0DEMO0009]', url: LINK }]);
    renderUI(<ChannelMessageCard card={report} onAction={vi.fn()} loadImage={loader()} />);
    expect(screen.getByTestId('channel-card-7-latest').textContent).toContain('这个报表对一下 report.pdf');
    await openCard();
    const chip = screen.getByTestId('channel-card-7-file-0-0');
    expect(chip.textContent).toBe('report.pdf· Open in Slack');
    expect(screen.getByTestId('channel-card-7-messages').textContent).not.toContain('文件编号');
    fireEvent.click(chip);
    expect(openURL).toHaveBeenCalledWith(LINK);
  });
});

// 手机宽度：一排放不下 4 张时少露几张，「+N」盖在这一排的最后一格，不折成两行。间距按最宽的一档（12）算。
describe('how many thumbnails fit in one row', () => {
  it('fits four on a wide card and fewer on a phone, never less than one', () => {
    expect(thumbsThatFit(null, 'lg', 4)).toBe(4);
    expect(thumbsThatFit(0, 'lg', 4)).toBe(4);
    expect(thumbsThatFit(900, 'lg', 4)).toBe(4);
    expect(thumbsThatFit(4 * 72 + 3 * 12, 'lg', 4)).toBe(4);
    expect(thumbsThatFit(300, 'lg', 4)).toBe(3);
    expect(thumbsThatFit(40, 'lg', 4)).toBe(1);
    expect(thumbsThatFit(200, 'sm', 4)).toBe(4);
  });
});
