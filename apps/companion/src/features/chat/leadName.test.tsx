// @vitest-environment jsdom
// Lead 的名字（设置 → 身份与风格，2026-10-22）：会话里称呼 Lead 的地方都用它，缺省是 Paimon。
// 改名以后 Lead 的回复照样是 Lead 的回复：「是不是系统通知」看这一轮的来源，不看发送者标签的文字。
// 以前的判断是 sender !== 'Lead'：名字一改，Lead 的每一条回复都会铺上系统通知的底色。
import type { ConversationTurn, LeadProfileDto } from '@pi-lead-child/protocol';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { formatConversationTime, LeadConversation } from './LeadConversation';

// 方案 C（2026-10-28，主题 11.14）：顶栏的 Lead 身份只在手机上和左栏收起时出现，这里按左栏收起渲染。
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SESSION = 'lead-session';
const JARVIS: LeadProfileDto = { name: 'Jarvis', persona: '', interactionStyle: '', updatedAt: null, updatedBy: null };

function turn(id: string, overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id, originBindingId: null, originKind: 'paired:companion', ticketId: null, state: 'completed',
    userText: '', assistantText: '', error: null,
    createdAt: '2026-10-22T08:00:00.000Z', updatedAt: '2026-10-22T08:00:00.000Z',
    ...overrides,
  };
}

// 用户问的一轮，Lead 自己发起的一轮（即时通知），daemon 自己写的一条安全报警。
const reply = turn('turn-reply', {
  userText: '今天有什么事', assistantText: '今天有三件事。',
  createdAt: '2026-10-22T08:00:00.000Z', updatedAt: '2026-10-22T08:01:00.000Z',
});
const proactive = turn('turn-proactive', {
  originKind: 'system:notification', assistantText: '#66 的核查通过了。',
  createdAt: '2026-10-22T08:10:00.000Z', updatedAt: '2026-10-22T08:11:00.000Z',
});
const alert = turn('turn-alert', {
  originKind: 'system:security-alert', assistantText: '有人绕过 API 改了账本里的设置。',
  createdAt: '2026-10-22T08:20:00.000Z', updatedAt: '2026-10-22T08:21:00.000Z',
});

function render(leadProfile: LeadProfileDto | null) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected', leadProfile });
  runtime.control.getState().replaceConversation(SESSION, [reply, proactive, alert]);
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation railOpen={false} /></CompanionRuntimeProvider>);
}

// 系统通知铺一层 accent-wash 的底色（LeadConversation 的 systemNotice）。Lead 的回复直接排在白底上。
function onNoticeSurface(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (getComputedStyle(node).backgroundColor === 'var(--c-accent-wash)') return true;
  }
  return false;
}

describe('the name of Lead in the conversation', () => {
  it('uses the custom name in the top bar, the composer and the sender labels', () => {
    render(JARVIS);
    const identity = screen.getByTestId('lead-identity');
    expect(identity.textContent).toContain('Jarvis');
    expect(identity.textContent).not.toContain('Paimon');
    expect(screen.getByTestId('lead-status-dot').getAttribute('aria-label')).toBe('Jarvis 在线');
    expect(screen.getByPlaceholderText('给 Jarvis 发消息')).toBeTruthy();
    expect(screen.getByText(`Jarvis · ${formatConversationTime(reply.updatedAt)}`)).toBeTruthy();
    // Lead 自己发起的回合也只写 Lead 的名字（方案 A）。
    expect(screen.getByText(`Jarvis · ${formatConversationTime(proactive.updatedAt)}`)).toBeTruthy();
    expect(screen.queryByText(/Paimon|Lead ·/)).toBeNull();
  });

  it('regression 2026-10-22: keeps Lead replies off the system notice surface after a rename', () => {
    render(JARVIS);
    expect(onNoticeSurface(screen.getByText('今天有三件事。'))).toBe(false);
    expect(onNoticeSurface(screen.getByText('#66 的核查通过了。'))).toBe(false);
    // daemon 自己写的通知照旧是系统通知。
    expect(screen.getByText(`系统通知 · 安全 · ${formatConversationTime(alert.updatedAt)}`)).toBeTruthy();
    expect(onNoticeSurface(screen.getByText('有人绕过 API 改了账本里的设置。'))).toBe(true);
  });

  it('says Paimon before the profile arrives', () => {
    render(null);
    expect(screen.getByTestId('lead-identity').textContent).toContain('Paimon');
    expect(screen.getByPlaceholderText('给 Paimon 发消息')).toBeTruthy();
    expect(screen.getByText(`Paimon · ${formatConversationTime(reply.updatedAt)}`)).toBeTruthy();
    expect(onNoticeSurface(screen.getByText('今天有三件事。'))).toBe(false);
  });
});
