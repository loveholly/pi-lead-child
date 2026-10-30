// @vitest-environment jsdom
// 设置 → 消息通道 → 代回复风格（2026-10-28）：框里写的保存走 reply_style.update（mode=replace）；提炼只读，结果在卡里预览、能改，
// 点「追加」才以 mode=append 写进框里，带上结果里的小标题。超过上限、框里有没保存的修改时不让追加。
// 契约在 packages/protocol/src/reply-style.ts。
import {
  REPLY_STYLE_TEXT_MAX_LENGTH, nextReplyStyleText,
  type ReplyStyleDto, type ReplyStyleExtractResult, type ReplyStyleUpdateRequest,
} from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRuntime } from '../../../test/connections';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { ReplyStyleSection } from './ReplyStyleSection';
import { replyStyleBasisLine, replyStyleErrorText } from './replyStyleModel';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/channels', Slot: () => null, Stack: () => null }));

const EMPTY: ReplyStyleDto = { text: '', updatedAt: null, updatedBy: null };

const RESULT: ReplyStyleExtractResult = {
  status: 'ok', proposal: '- 确认只说「好」\n- 不用感叹号',
  conflicts: [{ existing: '多用 emoji', observed: '很少用 emoji' }],
  basis: { days: 15, messages: 87, conversations: 30, from: '2026-10-21T04:53:28.000Z', to: '2026-10-28T03:40:00.000Z' },
  dropped: 2, label: '从 Slack 提炼：最近 15 天，87 条', note: null,
};

function styleRuntime(initial: ReplyStyleDto, result: ReplyStyleExtractResult = RESULT) {
  let current = initial;
  const fake = {
    getReplyStyle: vi.fn(async () => current),
    updateReplyStyle: vi.fn(async (request: ReplyStyleUpdateRequest) => {
      current = { text: nextReplyStyleText(current.text, request, new Date()), updatedAt: '2026-10-28T08:00:00.000Z', updatedBy: 'user' };
      return current;
    }),
    extractReplyStyle: vi.fn(async () => result),
  };
  const runtime = createCompanionStateRuntime({
    client: fake as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  return { runtime, client: fake };
}

async function renderSection(initial: ReplyStyleDto, result?: ReplyStyleExtractResult) {
  const setup = styleRuntime(initial, result);
  await act(async () => { renderWithRuntime(<ReplyStyleSection />, setup.runtime); });
  return setup;
}

describe('the reply style section', () => {
  it('saves what you wrote as the whole text', async () => {
    const { client } = await renderSection(EMPTY);
    expect(screen.getByTestId('reply-style-save').getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(screen.getByTestId('reply-style-text'), { target: { value: '- 极其精简' } });
    expect(screen.getByTestId('reply-style-count').textContent).toBe(`6 / ${REPLY_STYLE_TEXT_MAX_LENGTH} 字。保存以后，下一轮起生效。`);
    await act(async () => { fireEvent.click(screen.getByTestId('reply-style-save')); });
    expect(client.updateReplyStyle).toHaveBeenCalledWith({ mode: 'replace', text: '- 极其精简' });
    expect(screen.getByTestId('reply-style-message').textContent).toContain('从下一轮起按新的风格代你写');
  });

  it('previews what it extracted, lets you edit it, and appends it under the label without touching what was there', async () => {
    const { client } = await renderSection({ ...EMPTY, text: '- 极其精简' });
    await act(async () => { fireEvent.click(screen.getByTestId('reply-style-extract-run')); });
    expect(client.extractReplyStyle).toHaveBeenCalledWith({ days: 15 });
    expect(screen.getByTestId('reply-style-conflicts').textContent).toContain('框里写的是「多用 emoji」，最近的消息里是：很少用 emoji');
    expect(screen.getByTestId('reply-style-basis').textContent).toContain('最近 15 天你本人的 87 条消息，30 个对话');
    // 预览只是预览：没点追加以前什么都没写。
    expect(client.updateReplyStyle).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('reply-style-proposal'), { target: { value: '- 确认只说「好」' } });
    await act(async () => { fireEvent.click(screen.getByTestId('reply-style-append')); });
    expect(client.updateReplyStyle).toHaveBeenCalledWith({ mode: 'append', text: '- 确认只说「好」', label: '从 Slack 提炼：最近 15 天，87 条' });
    expect((screen.getByTestId('reply-style-text') as HTMLTextAreaElement).value).toMatch(/^- 极其精简\n\n### 从 Slack 提炼：最近 15 天，87 条（\d\d-\d\d）\n- 确认只说「好」$/u);
    expect(screen.queryByTestId('reply-style-preview')).toBeNull();
  });

  it('does not let you append past the limit or over unsaved edits', async () => {
    const full = { ...EMPTY, text: '甲'.repeat(REPLY_STYLE_TEXT_MAX_LENGTH - 5) };
    await renderSection(full);
    await act(async () => { fireEvent.click(screen.getByTestId('reply-style-extract-run')); });
    expect(screen.getByTestId('reply-style-append-problem').textContent).toContain('超了');
    expect(screen.getByTestId('reply-style-append').getAttribute('aria-disabled')).toBe('true');

    fireEvent.change(screen.getByTestId('reply-style-proposal'), { target: { value: '乙' } });
    fireEvent.change(screen.getByTestId('reply-style-text'), { target: { value: '- 改了一半' } });
    expect(screen.getByTestId('reply-style-append-dirty')).toBeTruthy();
    expect(screen.getByTestId('reply-style-append').getAttribute('aria-disabled')).toBe('true');
  });

  it('says so when there were too few of your messages, with no append button', async () => {
    await renderSection(EMPTY, {
      ...RESULT, status: 'too_few', proposal: '', conflicts: [], dropped: 0,
      basis: { ...RESULT.basis, messages: 4, conversations: 2 }, note: '最近 15 天只记下了你本人的 4 条消息，少于 10 条，先不提炼。',
    });
    await act(async () => { fireEvent.click(screen.getByTestId('reply-style-extract-run')); });
    expect(screen.getByTestId('reply-style-preview-note').textContent).toContain('少于 10 条');
    expect(screen.queryByTestId('reply-style-append')).toBeNull();
  });
});

describe('reply style text', () => {
  it('writes the basis and the errors in plain words', () => {
    expect(replyStyleBasisLine(RESULT)).toMatch(/^依据：最近 15 天你本人的 87 条消息，30 个对话，\d\d-\d\d 到 \d\d-\d\d。去掉了 2 行（抄了原文或者带着人名）。$/u);
    expect(replyStyleErrorText(Object.assign(new Error('x'), { status: 403 }))).toBe('这台设备不能改：要在主人的设备上改。');
    expect(replyStyleErrorText(new Error('this client cannot manage channel settings'))).toBe('这个版本的客户端不能改代回复风格。');
  });
});
