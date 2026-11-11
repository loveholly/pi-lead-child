// @vitest-environment happy-dom
// 会话卡片里的表单（工单 #285）：字段按类型画；第一次点提交以前不报错，之后不合格的字段标红、原因写在操作组左边那一行；
// 敏感字段是密码框，可以临时显示，提交以后清空；提交走 /v1/forms/:id/submit，成功以后收成一行结果；失败写原因，可以改了再交。
import { UI_CATALOG_VERSION, type UiFormDto, type UiSurface } from '@pi-lead-child/protocol';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { SurfaceView } from './SurfaceView';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const FORM = 'frm_test00000001';
const SECRET = 'tsk-client-secret-55aa';

const surface: UiSurface = {
  id: 'fast-form', catalogVersion: UI_CATALOG_VERSION, root: 'form', fallbackText: '请填公司决策模型的地址、模型名和 key。',
  nodes: [{
    id: 'form', type: 'Form', props: {
      target: { type: 'model_settings', id: 'models' }, action: 'save_fast_model', title: '添加一条直觉', submitLabel: '保存', form: FORM,
      fields: [
        { param: 'name', kind: 'text', label: '名字', default: '公司决策', required: true },
        { param: 'baseUrl', kind: 'text', label: '地址', required: true, validate: { format: 'url' } },
        { param: 'model', kind: 'text', label: '模型', default: 'decision-1', required: true },
        { param: 'apiKey', kind: 'secret', label: 'Key', required: true },
      ],
    },
  }],
};

const open: UiFormDto = { id: FORM, state: 'open', result: null };

function renderForm(initial: UiFormDto = open, value: UiSurface = surface) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  const get = vi.spyOn(runtime, 'getUiForm').mockResolvedValue(initial);
  const submit = vi.spyOn(runtime, 'submitUiForm');
  renderUI(<CompanionRuntimeProvider runtime={runtime}><SurfaceView surface={value} /></CompanionRuntimeProvider>);
  return { runtime, get, submit };
}

const input = (param: string) => screen.getByTestId(`surface-form-form-field-${param}-input`) as HTMLInputElement;

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('a form on a card', () => {
  it('draws each field with its default, a password box for the key, and no error before the first submit', async () => {
    renderForm();
    expect(await screen.findByText('添加一条直觉')).toBeTruthy();
    expect(input('name').value).toBe('公司决策');
    expect(input('model').value).toBe('decision-1');
    expect(input('apiKey').type).toBe('password');
    expect(screen.getByTestId('surface-form-form-status').textContent).toBe('Fields marked * are required.');
    // 密码框可以临时显示。
    fireEvent.click(screen.getByTestId('surface-form-form-field-apiKey-input-reveal'));
    expect(input('apiKey').type).toBe('text');
  });

  it('checks the values with the same rules as the daemon and sends nothing while one is bad', async () => {
    const { submit } = renderForm();
    await screen.findByText('添加一条直觉');
    fireEvent.change(input('baseUrl'), { target: { value: 'decision.example.com' } });
    fireEvent.click(screen.getByTestId('surface-form-form-submit'));
    expect(screen.getByTestId('surface-form-form-status').textContent).toBe('地址 must be an address that starts with http:// or https://.');
    expect(submit).not.toHaveBeenCalled();
    fireEvent.change(input('baseUrl'), { target: { value: 'https://decision.example.com' } });
    expect(screen.getByTestId('surface-form-form-status').textContent).toBe('Fill in Key.');
  });

  it('submits, clears the key from the page at once and folds into one result line', async () => {
    const { submit } = renderForm();
    let finish!: (dto: UiFormDto) => void;
    submit.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await screen.findByText('添加一条直觉');
    fireEvent.change(input('baseUrl'), { target: { value: 'https://decision.example.com' } });
    fireEvent.change(input('apiKey'), { target: { value: SECRET } });
    fireEvent.click(screen.getByTestId('surface-form-form-submit'));
    expect(submit).toHaveBeenCalledWith(FORM, { name: '公司决策', baseUrl: 'https://decision.example.com', model: 'decision-1', apiKey: SECRET });
    // 请求发出以后，key 马上从页面上清掉；不存进 localStorage。
    await waitFor(() => expect(input('apiKey').value).toBe(''));
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET);
    finish({ id: FORM, state: 'done', result: { ok: true, message: '添加了直觉 公司决策（decision.example.com）', at: '2026-11-06T08:30:00.000Z' } });
    expect(await screen.findByTestId('surface-form-form-done')).toBeTruthy();
    expect(screen.getByTestId('surface-form-form-result').textContent).toBe('添加了直觉 公司决策（decision.example.com）');
    expect(screen.queryByTestId('surface-form-form-submit')).toBeNull();
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('shows why a submit failed and lets the user fix it and submit again', async () => {
    const { submit } = renderForm({ id: FORM, state: 'failed', result: { ok: false, message: 'HTTP 401', at: '2026-11-06T08:30:00.000Z' } });
    expect(await screen.findByText('Not done: HTTP 401')).toBeTruthy();
    submit.mockResolvedValue({ id: FORM, state: 'done', result: { ok: true, message: '添加了直觉', at: '2026-11-06T08:31:00.000Z' } });
    fireEvent.change(input('baseUrl'), { target: { value: 'https://decision.example.com' } });
    fireEvent.change(input('apiKey'), { target: { value: SECRET } });
    fireEvent.click(screen.getByTestId('surface-form-form-submit'));
    expect(await screen.findByTestId('surface-form-form-done')).toBeTruthy();
  });

  it('starts as one line when the form was already submitted', async () => {
    renderForm({ id: FORM, state: 'done', result: { ok: true, message: '添加了直觉', at: '2026-11-06T08:30:00.000Z' } });
    expect(await screen.findByTestId('surface-form-form-done')).toBeTruthy();
    expect(screen.queryByTestId('surface-form-form-field-name')).toBeNull();
  });
});
