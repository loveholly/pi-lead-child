// @vitest-environment jsdom
// FairyEye 是隐藏模式（用户 2026-10-28 的底线：只有输入 /fairyeye on 才显示矢量组件）。
// 缺省时左栏、顶栏和消息头都画素材；daemon 说 fairyEye 开着时才画 FairyEye。
import type { ConversationTurn, LeadAvatarDto } from '@pi-lead-child/protocol';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { ConnectedWorkRail } from '../workspace/ConnectedWorkRail';
import { LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SESSION = 'lead-session';
const reply: ConversationTurn = {
  id: 'turn-1', originBindingId: null, originKind: 'paired:companion', ticketId: null, state: 'completed',
  userText: '今天有什么事', assistantText: '今天有三件事。', error: null,
  createdAt: '2026-10-28T08:00:00.000Z', updatedAt: '2026-10-28T08:01:00.000Z',
};
const AVATAR: LeadAvatarDto = {
  fairyEye: false,
  slots: { default: null, thinking: null, muted: null, offline: null },
  slackEmoji: ':robot_face:',
  slackEmojiSource: 'default',
  updatedAt: null,
  updatedBy: null,
};

function render(leadAvatar: LeadAvatarDto | null) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected', leadAvatar });
  runtime.control.getState().replaceConversation(SESSION, [reply]);
  renderUI(
    <CompanionRuntimeProvider runtime={runtime}>
      <ConnectedWorkRail connected ticketSummaries={[]} selectedTicketId={null} onSelectTicket={() => {}} />
      <LeadConversation railOpen={false} onOpenRail={() => {}} onOpenAll={() => {}} />
    </CompanionRuntimeProvider>,
  );
}

const AVATARS = ['work-rail-fairy', 'lead-identity-fairy', 'message-fairy'];

describe('the hidden FairyEye mode', () => {
  it.each([
    ['no avatar yet (new page, old daemon)', null],
    ['fairyEye off', AVATAR],
  ])('draws the image assets everywhere with %s', (_case, avatar) => {
    render(avatar);
    for (const id of AVATARS) {
      expect(screen.getByTestId(id), id).toBeTruthy();
      expect(screen.getByTestId(`${id}-image`), `${id} draws an image`).toBeTruthy();
    }
  });

  it('draws FairyEye only when the daemon says /fairyeye on turned it on', () => {
    render({ ...AVATAR, fairyEye: true });
    for (const id of AVATARS) {
      expect(screen.getByTestId(id), id).toBeTruthy();
      expect(screen.queryByTestId(`${id}-image`), `${id} is FairyEye`).toBeNull();
    }
  });
});
