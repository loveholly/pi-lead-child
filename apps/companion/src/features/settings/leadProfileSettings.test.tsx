// @vitest-environment jsdom
// 设置 → Lead → 身份与风格（2026-10-22）：名字、人格、互动风格。保存只发改了的字段，界面换成 daemon 回的值；
// 名字改了以后，用名字的地方马上跟着换（useLeadName）。契约在 packages/protocol/src/lead-profile.ts。
import type { LeadProfileDto } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRuntime } from '../../../test/connections';
import { useLeadName } from '../../state/hooks';
import { leadNameNow } from '../../state/leadName';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { LeadProfileSection } from './LeadProfileSection';
import { leadProfileChanges, leadProfileUpdatedLine } from './leadProfileModel';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/profile', Slot: () => null, Stack: () => null }));

const DEFAULT: LeadProfileDto = { name: 'Paimon', persona: '', interactionStyle: '', updatedAt: null, updatedBy: null };

function profileRuntime(initial: LeadProfileDto, update: (request: Record<string, string>) => LeadProfileDto) {
  const fake = {
    getLeadProfile: vi.fn(async () => initial),
    updateLeadProfile: vi.fn(async (request: Record<string, string>) => update(request)),
  };
  const runtime = createCompanionStateRuntime({
    client: fake as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view', 'tickets:create']);
  runtime.control.setState((state) => ({
    phase: 'ready',
    connectionState: 'connected',
    leadProfile: initial,
    resourceState: {
      ...state.resourceState,
      'lead-profile': { state: 'ready', generation: 0, observerCount: 0, lastSuccessAt: 0, error: null },
    },
  }));
  return { runtime, client: fake };
}

function NameProbe() {
  return <span data-testid="name-probe">{useLeadName()}</span>;
}

describe('the identity and style section', () => {
  it('sends only the changed fields and renames Lead everywhere at once', async () => {
    const { runtime, client } = profileRuntime(DEFAULT, (request) => ({
      ...DEFAULT, ...request, updatedAt: '2026-10-22T07:00:00.000Z', updatedBy: 'user',
    }));
    renderWithRuntime(<><LeadProfileSection /><NameProbe /></>, runtime);
    expect(screen.getByTestId('name-probe').textContent).toBe('Paimon');
    // 没有改动时不能保存。
    expect(screen.getByTestId('lead-profile-save').getAttribute('aria-disabled')).toBe('true');

    fireEvent.change(screen.getByTestId('lead-profile-name'), { target: { value: ' Jarvis ' } });
    fireEvent.change(screen.getByTestId('lead-profile-style'), { target: { value: '先给结论，最多三句' } });
    await act(async () => { fireEvent.click(screen.getByTestId('lead-profile-save')); });

    expect(client.updateLeadProfile).toHaveBeenCalledWith({ name: 'Jarvis', interactionStyle: '先给结论，最多三句' });
    expect(screen.getByTestId('lead-profile-message').textContent).toBe('已保存。Jarvis 从下一轮对话起按新的设置说话。');
    expect(screen.getByTestId('name-probe').textContent).toBe('Jarvis');
    expect(leadNameNow()).toBe('Jarvis');
    expect(screen.getByTestId('lead-profile-boundary').textContent).toContain('改不了 Jarvis 的权限和安全规则');
    expect(screen.getByTestId('lead-profile-updated').textContent).toContain('你改的');
  });

  it('says what is wrong instead of sending an empty name', async () => {
    const { runtime, client } = profileRuntime(DEFAULT, () => DEFAULT);
    renderWithRuntime(<LeadProfileSection />, runtime);
    fireEvent.change(screen.getByTestId('lead-profile-name'), { target: { value: '   ' } });
    await act(async () => { fireEvent.click(screen.getByTestId('lead-profile-save')); });
    expect(client.updateLeadProfile).not.toHaveBeenCalled();
    expect(screen.getByTestId('lead-profile-message').textContent).toBe('名字不能是空的');
  });

  it('says when Lead changed it in the conversation', () => {
    const now = new Date('2026-10-22T09:00:00.000Z');
    expect(leadProfileUpdatedLine({ ...DEFAULT, name: 'Jarvis', updatedAt: '2026-10-22T08:30:00.000Z', updatedBy: 'lead' }, now))
      .toMatch(/^最近一次修改：今天 \d\d:\d\d，Jarvis 在对话里按你的要求改的。$/);
    expect(leadProfileUpdatedLine(DEFAULT, now)).toBeNull();
    expect(leadProfileChanges({ name: 'Paimon ', persona: '', interactionStyle: '' }, DEFAULT)).toBeNull();
  });
});
