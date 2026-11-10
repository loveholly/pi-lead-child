// @vitest-environment happy-dom
// 界面语言（2026-11-01）：缺省英文；在设置 → 外观里选「中文」立即保存，整个界面马上换成中文，不等表单的「保存」。
// 语言存在外观偏好里（protocol 的 design-preferences.ts 的 locale），Lead 的 update_design_preferences 也能改。
import { DEFAULT_DESIGN_PREFERENCES, type DesignPreferencesDto, type DesignPreferencesRequest } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithRuntime } from '../../../test/connections';
import { DesignPreferencesBridge } from '../../components/DesignPreferencesBridge';
import { cachedLocale } from '../../i18n/localeCache';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { AppearanceSection } from './AppearanceSection';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/appearance', Slot: () => null, Stack: () => null }));

afterEach(() => localStorage.clear());

function appearanceRuntime(initial: DesignPreferencesDto) {
  let current = initial;
  const fake = {
    getDesignPreferences: vi.fn(async () => current),
    updateDesignPreferences: vi.fn(async (request: DesignPreferencesRequest) => {
      current = { ...current, ...request, updatedAt: '2026-11-01T07:00:00.000Z', updatedBy: 'user' } as DesignPreferencesDto;
      return current;
    }),
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
    designPreferences: initial,
    resourceState: {
      ...state.resourceState,
      'design-preferences': { state: 'ready', generation: 0, observerCount: 0, lastSuccessAt: 0, error: null },
    },
  }));
  return { runtime, client: fake };
}

describe('the interface language', () => {
  it('is English by default and switches the whole interface to Chinese at once', async () => {
    const { runtime, client } = appearanceRuntime(DEFAULT_DESIGN_PREFERENCES);
    renderWithRuntime(<DesignPreferencesBridge><AppearanceSection /></DesignPreferencesBridge>, runtime);
    expect(screen.getByTestId('appearance-save').textContent).toBe('Save');
    expect(screen.getByText('Corner radius')).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByTestId('appearance-locale-zh')); });
    expect(client.updateDesignPreferences).toHaveBeenCalledWith({ locale: 'zh' });
    expect(screen.getByTestId('appearance-save').textContent).toBe('保存');
    expect(screen.getByText('圆角')).toBeTruthy();
    // 记住选的语言：下次打开、还没连上 daemon 时也用中文画。
    expect(cachedLocale()).toBe('zh');
  });

  it('names each language in itself, so the user can find their own', async () => {
    const { runtime } = appearanceRuntime({ ...DEFAULT_DESIGN_PREFERENCES, locale: 'zh' });
    renderWithRuntime(<DesignPreferencesBridge><AppearanceSection /></DesignPreferencesBridge>, runtime);
    expect(screen.getByTestId('appearance-locale-en').textContent).toBe('English');
    expect(screen.getByTestId('appearance-locale-zh').textContent).toBe('中文');
  });
});
