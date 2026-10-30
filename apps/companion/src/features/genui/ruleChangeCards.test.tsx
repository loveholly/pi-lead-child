// @vitest-environment jsdom
// 改规则被拦下以后的确认卡（统一的消息事件 spec D10 的「放行」，工单 09）：Lead 把系统给的 user_action（confirm_rule_change）
// 原样放进 UserAction。卡片只带确认号，要改什么、参数、为什么改、为什么被拦都从 /v1/rule-changes/:id 读；
// 「确认这一次」「不改」走只有用户能按到的路由。样子是审批模式（docs/design P9.2、主题 11.4）。
import { ControlPlaneClientError } from '@pi-lead-child/client';
import type { RuleChangeConfirmationDto, UiSurface } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { connectionsRuntime, renderWithRuntime, type FakeConnectionClient } from '../../../test/connections';
import { SurfaceView } from './SurfaceView';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const ID = 'rcc_AbCdEfGh1234';

function confirmation(overrides: Partial<RuleChangeConfirmationDto> = {}): RuleChangeConfirmationDto {
  return {
    id: ID,
    state: 'pending',
    label: '改常设指令',
    name: null,
    operation: { kind: 'lead_tool', tool: 'propose_standing_order_change' },
    params: [{ name: 'op', value: 'update' }, { name: 'id', value: 'run.transient_retry' }, { name: 'limits', value: '{"count":0}' }],
    reason: '定时器的安排：每天 9 点先关掉瞬时失败的自动重试',
    why: '这一轮用 read_channel_conversation 读了外部内容',
    externalContent: [{ via: 'tool', tool: 'read_channel_conversation' }],
    where: '设置 → Lead → 常设指令',
    createdAt: '2026-10-27T01:00:00.000Z',
    expiresAt: '2026-10-28T01:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    resultPreview: null,
    ...overrides,
  };
}

function surface(): UiSurface {
  return {
    id: 'surface-rule-change', catalogVersion: 1, root: 'act', fallbackText: '要改常设指令，等你确认。',
    nodes: [{
      id: 'act', type: 'UserAction',
      props: { action: { kind: 'confirm_rule_change', target: `rule_change:${ID}`, title: '确认这一次', reason: '定时器的安排' } },
    }],
  };
}

function runtimeWith(client: { ruleChangeConfirmation: ReturnType<typeof vi.fn>; resolveRuleChangeConfirmation?: ReturnType<typeof vi.fn> }) {
  const fake = { resolveRuleChangeConfirmation: vi.fn(() => new Promise(() => {})), ...client };
  return connectionsRuntime([], fake as unknown as Partial<FakeConnectionClient>);
}

describe('the confirm card for a refused rule change', () => {
  it('shows what changes, the parameters, why, and why it was stopped; 确认这一次 runs it', async () => {
    const { runtime, client } = runtimeWith({
      ruleChangeConfirmation: vi.fn(async () => confirmation()),
      resolveRuleChangeConfirmation: vi.fn(async () => confirmation({
        state: 'done', resolvedAt: '2026-10-27T01:05:00.000Z', resolvedBy: 'user via Mac 网页（binding 1）', resultPreview: '已经生效：常设指令 run.transient_retry 第 2 版',
      })),
    });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    expect((client as any).ruleChangeConfirmation).toHaveBeenCalledWith(ID, expect.any(AbortSignal));
    const card = screen.getByTestId(`surface-rule-change-${ID}`);
    expect(screen.getByTestId(`surface-rule-change-${ID}-state`).textContent).toBe('等你确认');
    expect(card.textContent).toContain('要改常设指令');
    expect(screen.getByTestId(`surface-rule-change-${ID}-params`).textContent).toContain('limits');
    expect(screen.getByTestId(`surface-rule-change-${ID}-params`).textContent).toContain('{"count":0}');
    expect(card.textContent).toContain('定时器的安排：每天 9 点先关掉瞬时失败的自动重试');
    expect(card.textContent).toContain('这一轮用 read_channel_conversation 读了外部内容');

    await act(async () => { fireEvent.click(screen.getByTestId(`surface-rule-change-${ID}-confirm`)); });
    expect((client as any).resolveRuleChangeConfirmation).toHaveBeenCalledWith(ID, 'confirm');
    expect(screen.getByTestId(`surface-rule-change-${ID}-state`).textContent).toBe('已执行');
    expect(screen.getByTestId(`surface-rule-change-${ID}-result`).textContent).toContain('第 2 版');
    expect(screen.queryByTestId(`surface-rule-change-${ID}-confirm`)).toBeNull();
    expect(screen.queryByTestId(`surface-rule-change-${ID}-decline`)).toBeNull();
  });

  it('keeps the rule as it is with 不改', async () => {
    const { runtime, client } = runtimeWith({
      ruleChangeConfirmation: vi.fn(async () => confirmation()),
      resolveRuleChangeConfirmation: vi.fn(async () => confirmation({ state: 'declined', resolvedAt: '2026-10-27T01:05:00.000Z' })),
    });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    await act(async () => { fireEvent.click(screen.getByTestId(`surface-rule-change-${ID}-decline`)); });
    expect((client as any).resolveRuleChangeConfirmation).toHaveBeenCalledWith(ID, 'decline');
    expect(screen.getByTestId(`surface-rule-change-${ID}-state`).textContent).toBe('没有改');
    expect(screen.queryByTestId(`surface-rule-change-${ID}-confirm`)).toBeNull();
  });

  it('shows the current state of a card that was already handled, without buttons', async () => {
    const { runtime } = runtimeWith({ ruleChangeConfirmation: vi.fn(async () => confirmation({ state: 'expired' })) });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    expect(screen.getByTestId(`surface-rule-change-${ID}-state`).textContent).toBe('已过期');
    expect(screen.queryByTestId(`surface-rule-change-${ID}-confirm`)).toBeNull();
  });

  it('shows why when confirming fails, and reads the card again', async () => {
    const read = vi.fn(async () => confirmation());
    const { runtime } = runtimeWith({
      ruleChangeConfirmation: read,
      resolveRuleChangeConfirmation: vi.fn(async () => { throw new ControlPlaneClientError('这张确认卡已经处理过了', 'conflict', 409); }),
    });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    read.mockResolvedValue(confirmation({ state: 'declined', resolvedAt: '2026-10-27T01:05:00.000Z' }));
    await act(async () => { fireEvent.click(screen.getByTestId(`surface-rule-change-${ID}-confirm`)); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId(`surface-rule-change-${ID}-error`).textContent).toContain('已经处理过了');
    expect(screen.getByTestId(`surface-rule-change-${ID}-state`).textContent).toBe('没有改');
  });
});
