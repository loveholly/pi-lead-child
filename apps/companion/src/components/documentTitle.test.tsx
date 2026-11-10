// @vitest-environment happy-dom
// 网页标题是 Lead 的名字：桌面版的窗口标题跟着它走（docs/desktop/macos-desktop-design.md 第 4.1 节，P0-4）。
import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../test/render';
import { CompanionRuntimeProvider } from '../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../state/runtime';
import { DocumentTitle } from './DocumentTitle';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));

function profile(name: string) {
  return { name, persona: '', interactionStyle: '', updatedAt: null, updatedBy: null };
}

function renderTitle() {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  renderUI(<CompanionRuntimeProvider runtime={runtime}><DocumentTitle /></CompanionRuntimeProvider>);
  return runtime;
}

describe('the page title', () => {
  it('is the Lead name before the profile arrives', () => {
    document.title = 'something else';
    renderTitle();
    expect(document.title).toBe('Paimon');
  });

  it('follows the Lead name when the user renames Lead', () => {
    const runtime = renderTitle();
    act(() => runtime.control.setState({ leadProfile: profile('Jarvis') }));
    expect(document.title).toBe('Jarvis');
    act(() => runtime.control.setState({ leadProfile: profile('Nina') }));
    expect(document.title).toBe('Nina');
  });
});
