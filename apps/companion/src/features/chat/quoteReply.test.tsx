// @vitest-environment happy-dom
// 引用回复（设计规范 P17、主题 11.22）在 Lead 的会话里：
//   · 桌面上选中 Lead 回答里的一段，选区上出「回复」；点它撑开引用浮层，Enter 收进托盘，⌘Enter 直接发送；
//   · 托盘一条一行，× 去掉；发送时托盘里的引用和文字一起发，发完清空；
//   · 你的气泡里，正文上面画着你引用的几段；
//   · 手机的悬浮输入框：正在引用时输入的字是对这段的说明，「加上」收进托盘。
//   · daemon 不收引用时没有「回复」，也没有托盘。
import { CHAT_QUOTES_CAPABILITY, type ConversationTurn, type LeadStatus, type Overview } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { LeadConversation } from './LeadConversation';
import { MessageComposer } from './MessageComposer';
import { quoteDrafts } from './quoteDrafts';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});

const SESSION = 'lead-session';
const online: LeadStatus = {
  state: 'online', since: null, failures: 0, reason: null, detail: null, nextAttemptAt: null, lastSuccessAt: null,
};
const overview = (): Overview => ({
  model: 'anthropic/claude-opus-5-5', sessionId: SESSION, busy: false, runningTicketIds: [],
  counts: { activeTickets: 0, reviewTickets: 0, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
  aish: null, lead: online,
});
const ANSWER = '压缩完成。空闲时到 0.7 倍就会提前压缩，所以平时碰不到上限。';
const turn = (extra: Partial<ConversationTurn> = {}): ConversationTurn => ({
  id: 'turn-a', originBindingId: 1, originKind: 'paired:companion', ticketId: null, state: 'completed',
  userText: '压缩一下上下文', assistantText: ANSWER, error: null,
  createdAt: '2026-11-18T11:00:00.000Z', updatedAt: '2026-11-18T11:00:05.000Z', ...extra,
});
const leadSource = { kind: 'turn' as const, turnId: 'turn-a', role: 'assistant' as const };

function setup(options: { capabilities?: string[]; turns?: ConversationTurn[] } = {}) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({
    phase: 'ready', connectionState: 'connected', overview: overview(), capabilities: options.capabilities ?? [CHAT_QUOTES_CAPABILITY],
  });
  runtime.control.getState().replaceConversation(SESSION, options.turns ?? [turn()]);
  const sendChat = vi.spyOn(runtime, 'sendChat').mockResolvedValue({ clientMessageId: 'msg_1' });
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
  return { runtime, sendChat };
}

// 选中 Lead 回答里的一段字：happy-dom 量不出选区的大小，给它一个。
function selectInAnswer(text: string) {
  const container = document.querySelector('[data-quote-key="turn:turn-a:assistant"]')!;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const at = node.data.indexOf(text);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + text.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  throw new Error(`text not found: ${text}`);
}

beforeEach(() => {
  quoteDrafts.getState().clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 100, bottom: 124, left: 40, right: 240, width: 200, height: 24, x: 40, y: 100, toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('replying to selected text on the desktop', () => {
  it('offers Reply on a selection in a Lead answer, adds it to the tray on Enter, and sends it with the message', async () => {
    const { sendChat } = setup();
    selectInAnswer('空闲时到 0.7 倍就会提前压缩');
    await act(async () => {
      fireEvent.mouseUp(document);
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.click(await screen.findByTestId('quote-reply-button'));

    const panel = await screen.findByTestId('quote-panel');
    expect(panel.textContent).toContain('空闲时到 0.7 倍就会提前压缩');
    const note = screen.getByTestId('quote-note') as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: '能调到 0.5 吗？' } });
    fireEvent.keyDown(note, { key: 'Enter', code: 'Enter' });

    await waitFor(() => expect(screen.queryByTestId('quote-panel')).toBeNull());
    expect(screen.getByTestId('quote-tray').textContent).toContain('能调到 0.5 吗？');

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '顺便看看成本' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(sendChat).toHaveBeenCalledWith('顺便看看成本', undefined, undefined, undefined, undefined, [
      { source: leadSource, text: '空闲时到 0.7 倍就会提前压缩', note: '能调到 0.5 吗？', anchor: 'n:0' },
    ]);
    expect(screen.queryByTestId('quote-tray')).toBeNull();
  });

  it('sends the quote at once on Cmd+Enter, with no message text', async () => {
    const { sendChat } = setup();
    selectInAnswer('提前压缩');
    await act(async () => {
      fireEvent.mouseUp(document);
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.click(await screen.findByTestId('quote-reply-button'));
    const note = await screen.findByTestId('quote-note');
    fireEvent.change(note, { target: { value: '为什么是 0.7？' } });
    fireEvent.keyDown(note, { key: 'Enter', code: 'Enter', metaKey: true });
    expect(sendChat).toHaveBeenCalledWith('', undefined, undefined, undefined, undefined, [
      { source: leadSource, text: '提前压缩', note: '为什么是 0.7？', anchor: 'n:0' },
    ]);
  });

  // 回答里有链接（Lead 常写的工单链接「[#12](plc:ticket/12)」）：会话里只显示「#12」，原文里还有地址。
  // 选区从链接前面跨到链接后面时，以前核对对不上，「回复」不出现（引用浮层也就打不开）。
  it('offers Reply on a selection that runs across a link in the answer, and sends the quote as shown', async () => {
    const linked = '两张单都核查通过了：[#12](plc:ticket/12) 收不到机器人回复，[说明](https://example.com/doc) 里写了原因。';
    const { sendChat } = setup({ turns: [turn({ assistantText: linked })] });
    const container = document.querySelector('[data-quote-key="turn:turn-a:assistant"]')!;
    const texts: Text[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) texts.push(node);
    const start = texts.find((node) => node.data.includes('都核查通过了'))!;
    const end = texts.find((node) => node.data.includes('里写了原因'))!;
    const range = document.createRange();
    range.setStart(start, start.data.indexOf('都核查通过了'));
    range.setEnd(end, end.data.indexOf('里写了原因') + '里写了原因'.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(range.toString()).toContain('#12');
    expect(range.toString()).not.toContain('plc:ticket');

    await act(async () => {
      fireEvent.mouseUp(document);
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.click(await screen.findByTestId('quote-reply-button'));
    const note = await screen.findByTestId('quote-note');
    fireEvent.keyDown(note, { key: 'Enter', code: 'Enter', metaKey: true });
    expect(sendChat).toHaveBeenCalledWith('', undefined, undefined, undefined, undefined, [
      expect.objectContaining({ source: leadSource, text: range.toString().trim() }),
    ]);
  });

  // 三击（macOS 上双击后再点一下也一样）选中一整段：浏览器把选区的终点放在这一段后面那个块的开头。
  // 这一段是回答的最后一段时，终点落在回答外面，这时也要出「回复」，引用的是回答里的那一段。
  it('offers Reply when a triple click selects the last paragraph and the selection ends after the answer', async () => {
    const { sendChat } = setup();
    const container = document.querySelector('[data-quote-key="turn:turn-a:assistant"]')!;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let first: Text | null = null;
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (node.data.includes('压缩完成')) { first = node; break; }
    }
    const after = [...document.body.querySelectorAll('*')].find((element) =>
      !container.contains(element) && Boolean(container.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))!;
    const range = document.createRange();
    range.setStart(first!, first!.data.indexOf('压缩完成'));
    range.setEnd(after, 0);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () => {
      fireEvent.mouseUp(document);
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.click(await screen.findByTestId('quote-reply-button'));
    const note = await screen.findByTestId('quote-note');
    fireEvent.keyDown(note, { key: 'Enter', code: 'Enter', metaKey: true });
    expect(sendChat).toHaveBeenCalledWith('', undefined, undefined, undefined, undefined, [
      { source: leadSource, text: ANSWER, anchor: 'n:0' },
    ]);
  });

  it('offers no Reply when a selection runs from one message into another', async () => {
    setup({ turns: [turn(), turn({ id: 'turn-b', userText: '再说一遍', assistantText: '好的，再说一遍。' })] });
    const from = document.querySelector('[data-quote-key="turn:turn-a:assistant"]')!;
    const to = document.querySelector('[data-quote-key="turn:turn-b:assistant"]')!;
    const [early, late] = from.compareDocumentPosition(to) & Node.DOCUMENT_POSITION_FOLLOWING ? [from, to] : [to, from];
    const range = document.createRange();
    range.setStart(early, 0);
    range.setEnd(late, late.childNodes.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () => {
      fireEvent.mouseUp(document);
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.queryByTestId('quote-reply-button')).toBeNull();
  });

  it('keeps the rounded top corners of the composer when the tray shows', async () => {
    setup();
    act(() => {
      quoteDrafts.getState().begin({ source: leadSource, text: '提前压缩' });
      quoteDrafts.getState().commit();
    });
    await screen.findByTestId('quote-tray');
    // 托盘的底色是方角：卡片要裁掉它，不然盖住卡片上面两个圆角的边框。
    expect(getComputedStyle(screen.getByTestId('composer')).overflow).toBe('hidden');
  });

  it('offers no Reply for text that is not in the answer, or when the daemon does not take quotes', async () => {
    setup({ capabilities: [] });
    selectInAnswer('提前压缩');
    await act(async () => {
      fireEvent.mouseUp(document);
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.queryByTestId('quote-reply-button')).toBeNull();
    expect(screen.queryByTestId('quote-tray')).toBeNull();
  });

  it('removes a quote from the tray with its close button', async () => {
    setup();
    act(() => {
      quoteDrafts.getState().begin({ source: leadSource, text: '提前压缩' });
      quoteDrafts.getState().commit();
    });
    const id = quoteDrafts.getState().drafts[0]!.id;
    fireEvent.click(await screen.findByTestId(`quote-tray-remove-${id}`));
    expect(screen.queryByTestId('quote-tray')).toBeNull();
  });
});

describe('quotes in your bubble', () => {
  it('shows the quotes above the text of your message', () => {
    setup({
      turns: [turn(), turn({
        id: 'turn-b', userText: '这两处一起看下', assistantText: '好。',
        quotes: [{ source: leadSource, author: 'lead', text: '提前压缩', note: '为什么？' }],
      })],
    });
    const quotes = screen.getByTestId('user-message-quotes');
    expect(quotes.textContent).toContain('提前压缩');
    expect(quotes.textContent).toContain('为什么？');
  });
});

describe('quoting on the phone composer', () => {
  // 2026-11-19 用户截图：手机的悬浮输入框有内边距，托盘在内边距里面是直角的，看起来很尖。
  // 托盘的四角是 20（输入框 28 减去内边距 8，同心圆角），也不要下面那条分隔线。
  it('rounds the tray inside the floating composer', async () => {
    const runtime = createCompanionStateRuntime({
      client: {} as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    });
    renderUI(
      <CompanionRuntimeProvider runtime={runtime}>
        <MessageComposer contextKey="lead" placeholder="Message" onSend={vi.fn()} float quotes />
      </CompanionRuntimeProvider>,
    );
    act(() => {
      quoteDrafts.getState().begin({ source: leadSource, text: ANSWER, context: ANSWER });
      quoteDrafts.getState().commit();
    });
    const tray = getComputedStyle(await screen.findByTestId('quote-tray'));
    expect(tray.borderTopLeftRadius).toBe('20px');
    expect(tray.borderBottomRightRadius).toBe('20px');
    expect(tray.borderBottomWidth === '' || tray.borderBottomWidth === '0px').toBe(true);
    // 左右边距照视觉稿：回复图标离托盘左边 12（托盘 6 + 一行 6），× 贴着一行的右边（托盘 6，一行 0）。
    // 以前托盘 12、一行左右各 6，两头都多了一截（2026-11-19 用户截图）。
    expect(tray.paddingLeft).toBe('6px');
    expect(tray.paddingRight).toBe('6px');
    const row = getComputedStyle(screen.getByTestId(`quote-tray-row-${quoteDrafts.getState().drafts[0]!.id}`));
    expect(row.paddingLeft).toBe('6px');
    expect(row.paddingRight === '' || row.paddingRight === '0px').toBe(true);
  });


  it('types the note of the quote in hand, and Add puts it in the tray', async () => {
    const runtime = createCompanionStateRuntime({
      client: {} as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    });
    const onSend = vi.fn();
    renderUI(
      <CompanionRuntimeProvider runtime={runtime}>
        <MessageComposer contextKey="lead" placeholder="Message" onSend={onSend} float quotes />
      </CompanionRuntimeProvider>,
    );
    act(() => quoteDrafts.getState().begin({ source: leadSource, text: ANSWER, context: ANSWER }));
    expect(await screen.findByTestId('quoting-slot')).toBeTruthy();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '这句对吗' } });
    expect(quoteDrafts.getState().pending?.note).toBe('这句对吗');
    fireEvent.click(screen.getByTestId('quote-add'));
    await waitFor(() => expect(screen.queryByTestId('quoting-slot')).toBeNull());
    expect(screen.getByTestId('quote-tray').textContent).toContain('这句对吗');
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('');

    fireEvent.click(screen.getByTestId('send-message'));
    expect(onSend).toHaveBeenCalledWith('', [], [{ source: leadSource, text: ANSWER, note: '这句对吗' }]);
  });
});
