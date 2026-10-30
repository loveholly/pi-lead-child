// @vitest-environment jsdom
// 会话的输入框（2026-10-25，参考 Kimi）：一张卡片，上面是待发的图片，中间是多行文字，下面是「+」、模型名和发送按钮。
// Enter 发送，Shift+Enter 换行，输入法组字时的 Enter 不发送；点「+」选图片，或者粘贴剪贴板里的图片；
// 每张图片是一个 64×64 的小图，可以删掉单张；文字和图片一起发给 Lead。daemon 不收图片时没有「+」。
import { CHAT_IMAGES_CAPABILITY, type ConversationTurn, type LeadStatus, type Overview } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pickImageFiles, prepareChatImage } from '@/data/chatImagePicker';
import { composerImage } from '@/data/chatImagePicker.types';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
// 浏览器里的选图和缩小（canvas、createImageBitmap）jsdom 没有：换成按文件名给出一张图的替身。
vi.mock('@/data/chatImagePicker', async () => {
  const types = await vi.importActual<typeof import('@/data/chatImagePicker.types')>('@/data/chatImagePicker.types');
  return {
    ChatImageError: types.ChatImageError,
    canPickImages: true,
    pickImageFiles: vi.fn(async () => []),
    prepareChatImage: vi.fn(async (file: File) => {
      if (file.name.startsWith('broken')) throw new types.ChatImageError('这张图片打不开');
      return types.composerImage(`key-${file.name}`, { mimeType: 'image/png', data: btoa(file.name) });
    }),
  };
});
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});

const SESSION = 'lead-session';
const online: LeadStatus = {
  state: 'online', since: null, failures: 0, reason: null, detail: null, nextAttemptAt: null, lastSuccessAt: null,
};

function overview(): Overview {
  return {
    model: 'anthropic/claude-opus-5-5', sessionId: SESSION, busy: false, runningTicketIds: [],
    counts: { activeTickets: 0, reviewTickets: 0, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
    aish: null, lead: online,
  };
}

function setup(options: { capabilities?: string[]; turns?: ConversationTurn[]; getChatImage?: unknown } = {}) {
  const runtime = createCompanionStateRuntime({
    client: (options.getChatImage ? { getChatImage: options.getChatImage } : {}) as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({
    phase: 'ready', connectionState: 'connected', overview: overview(),
    capabilities: options.capabilities ?? [CHAT_IMAGES_CAPABILITY],
  });
  runtime.control.getState().replaceConversation(SESSION, options.turns ?? []);
  const sendChat = vi.spyOn(runtime, 'sendChat').mockResolvedValue({ clientMessageId: 'msg_1' });
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
  return { runtime, sendChat };
}

const input = () => screen.getByTestId('composer-input') as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const enter = (init: KeyboardEventInit & { keyCode?: number } = {}) =>
  fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter', keyCode: 13, ...init });
const png = (name: string) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });

async function paste(files: File[], text = '') {
  await act(async () => {
    fireEvent.paste(input(), {
      clipboardData: {
        getData: (kind: string) => (kind === 'text/plain' ? text : ''),
        items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
        files,
      },
    });
  });
}

const thumbnails = () => screen.queryAllByTestId(/^composer-image-\d+$/);

beforeEach(() => {
  vi.mocked(pickImageFiles).mockReset().mockResolvedValue([]);
  vi.mocked(prepareChatImage).mockClear();
});

describe('the message composer', () => {
  it('sends on Enter, puts a newline on Shift+Enter, and leaves the Enter that confirms a candidate alone', () => {
    const { sendChat } = setup();
    expect(input().tagName).toBe('TEXTAREA');
    expect(input().placeholder).toBe('给 Paimon 发消息');
    type('第一行');
    enter({ shiftKey: true });
    enter({ isComposing: true });
    enter({ keyCode: 229 });
    expect(sendChat).not.toHaveBeenCalled();
    type('第一行\n第二行');
    enter();
    // 只有文字的消息和以前一样发（不带图片参数）。
    expect(sendChat).toHaveBeenCalledWith('第一行\n第二行', undefined, undefined);
    expect(input().value).toBe('');
  });

  it('keeps the send button grey and inactive until there is something to send', () => {
    const { sendChat } = setup();
    const send = screen.getByTestId('send-message');
    expect(send.getAttribute('aria-disabled')).toBe('true');
    enter();
    fireEvent.click(send);
    expect(sendChat).not.toHaveBeenCalled();
    type('在吗');
    expect(screen.getByTestId('send-message').getAttribute('aria-disabled')).toBeNull();
  });

  it('shows pasted images above the text, removes one, and sends the rest with the text', async () => {
    const { sendChat } = setup();
    await paste([png('a.png'), png('b.png')]);
    await waitFor(() => expect(thumbnails()).toHaveLength(2));
    expect(screen.getByTestId('composer-image-0').querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${btoa('a.png')}`);

    fireEvent.click(screen.getByTestId('composer-image-0-remove'));
    expect(thumbnails()).toHaveLength(1);
    expect(screen.getByTestId('composer-image-0').getAttribute('aria-label')).toBe('图片 1');

    type('看这张');
    enter();
    expect(sendChat).toHaveBeenCalledWith('看这张', undefined, undefined, [{ mimeType: 'image/png', data: btoa('b.png') }]);
    expect(thumbnails()).toHaveLength(0);
  });

  it('pastes text as text even when the clipboard also has an image', async () => {
    setup();
    await paste([png('cells.png')], 'A1\tB1');
    expect(prepareChatImage).not.toHaveBeenCalled();
    expect(thumbnails()).toHaveLength(0);
  });

  it('adds images picked from the + button, and sends an image without text', async () => {
    const { sendChat } = setup();
    vi.mocked(pickImageFiles).mockResolvedValue([png('photo.png')]);
    await act(async () => { fireEvent.click(screen.getByTestId('composer-attach')); });
    await waitFor(() => expect(thumbnails()).toHaveLength(1));
    fireEvent.click(screen.getByTestId('send-message'));
    expect(sendChat).toHaveBeenCalledWith('', undefined, undefined, [{ mimeType: 'image/png', data: btoa('photo.png') }]);
  });

  it('keeps at most 8 images and says why one could not be added', async () => {
    setup();
    await paste(Array.from({ length: 9 }, (_, index) => png(`${index}.png`)));
    await waitFor(() => expect(thumbnails()).toHaveLength(8));
    expect(screen.getByTestId('composer-notice').textContent).toBe('一条消息最多带 8 张图片，多出来的没有加上');

    fireEvent.click(screen.getByTestId('composer-image-0-remove'));
    await paste([png('broken.png')]);
    await waitFor(() => expect(screen.getByTestId('composer-notice').textContent).toBe('这张图片打不开'));
    expect(thumbnails()).toHaveLength(7);
  });

  it('has no + button, and ignores pasted images, when the daemon does not accept images', async () => {
    setup({ capabilities: [] });
    expect(screen.queryByTestId('composer-attach')).toBeNull();
    await paste([png('a.png')]);
    expect(prepareChatImage).not.toHaveBeenCalled();
    expect(thumbnails()).toHaveLength(0);
  });

  it('writes the model Lead uses on the right, without the provider', () => {
    setup();
    expect(screen.getByTestId('composer-model').textContent).toBe('claude-opus-5-5');
  });
});

describe('images in the conversation', () => {
  it('shows the images you sent above your message, and an image-only message without a bubble', async () => {
    const getChatImage = vi.fn(async (id: string) => ({ id, mimeType: 'image/png', data: 'iVBORw0KGgo=' }));
    const turns: ConversationTurn[] = [
      {
        id: 'turn-1', originBindingId: 1, originKind: 'paired:companion', ticketId: null, state: 'completed',
        userText: '这是什么', assistantText: '一张图。', error: null,
        createdAt: '2026-10-25T01:00:00.000Z', updatedAt: '2026-10-25T01:00:01.000Z',
        images: [{ id: 'img_1', mimeType: 'image/png' }],
      },
      {
        id: 'turn-2', originBindingId: 1, originKind: 'paired:companion', ticketId: null, state: 'completed',
        userText: '', assistantText: '又一张。', error: null,
        createdAt: '2026-10-25T01:01:00.000Z', updatedAt: '2026-10-25T01:01:01.000Z',
        images: [{ id: 'img_2', mimeType: 'image/png' }],
      },
    ];
    setup({ turns, getChatImage });
    const messages = screen.getAllByTestId('user-message');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.textContent).toContain('这是什么');
    await waitFor(() => expect(messages[0]!.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo='));
    expect(messages[0]!.querySelector('[data-testid="user-bubble"]')).not.toBeNull();
    // 只发了图片：有小图，没有空的气泡。
    expect(messages[1]!.querySelector('[data-testid="user-message-images"]')).not.toBeNull();
    expect(messages[1]!.querySelector('[data-testid="user-bubble"]')).toBeNull();
    expect(getChatImage).toHaveBeenCalledTimes(2);
  });
});

// composerImage 是替身和真实现共用的：地址就是图片的 data: URI。
describe('composerImage', () => {
  it('builds a data URI the thumbnail can show', () => {
    expect(composerImage('k', { mimeType: 'image/webp', data: 'UklGRg==' }).uri).toBe('data:image/webp;base64,UklGRg==');
  });
});
