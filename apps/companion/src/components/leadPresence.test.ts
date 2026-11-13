// Lead 状态点的说法跟着界面语言（2026-11-01）：缺省英文，选了中文时是原来的中文。
import { describe, expect, it } from 'vitest';

import { leadPresence } from './leadPresence';

const NOW = Date.parse('2026-10-20T02:00:00.000Z');

describe('the Lead presence text', () => {
  it('is English by default', () => {
    expect(leadPresence({ connectionState: 'disconnected', phase: 'unpaired', lead: undefined, name: 'Paimon', now: NOW }))
      .toMatchObject({ state: 'offline', label: 'Not paired · Click to pair' });
    expect(leadPresence({ connectionState: 'reconnecting', phase: 'ready', lead: undefined, name: 'Paimon', now: NOW }))
      .toMatchObject({ label: 'Paimon is offline', subtitle: 'Offline · Reconnecting' });
    expect(leadPresence({ connectionState: 'connected', phase: 'ready', lead: undefined, name: 'Paimon', now: NOW }))
      .toMatchObject({ state: 'online', label: 'Paimon is online', subtitle: null });
  });

  it('uses the original Chinese when the interface language is Chinese', () => {
    expect(leadPresence({ connectionState: 'disconnected', phase: 'unpaired', lead: undefined, name: 'Paimon', now: NOW, locale: 'zh' }))
      .toMatchObject({ label: '未配对 · 点击配对' });
    expect(leadPresence({ connectionState: 'reconnecting', phase: 'ready', lead: undefined, name: 'Paimon', now: NOW, locale: 'zh' }))
      .toMatchObject({ label: 'Paimon 离线', subtitle: '离线 · 正在重连' });
    expect(leadPresence({ connectionState: 'connected', phase: 'ready', lead: undefined, name: 'Paimon', now: NOW, locale: 'zh' }))
      .toMatchObject({ label: 'Paimon 在线' });
  });

  // 回归：模型的服务商没有 key 时（pi 的 "No API key found for openai."），以前顶栏是绿点；现在叫人去设置 → 模型。
  it('sends the user to Settings → Models when the model has no API key', () => {
    const lead = {
      state: 'degraded' as const, since: '2026-10-20T01:00:00.000Z', failures: 3, reason: 'Paimon 的模型账号认证失败',
      detail: 'No API key found for openai.', nextAttemptAt: null, lastSuccessAt: null,
    };
    expect(leadPresence({ connectionState: 'connected', phase: 'ready', lead, name: 'Paimon', now: NOW }))
      .toMatchObject({ state: 'degraded', dotColor: 'danger', needsModelSetup: true, subtitle: expect.stringContaining('Settings → Models') });
    expect(leadPresence({ connectionState: 'connected', phase: 'ready', lead, name: 'Paimon', now: NOW, locale: 'zh' }))
      .toMatchObject({ subtitle: expect.stringContaining('设置 → 模型') });
    // 会自己恢复的降级不叫人去设置。
    expect(leadPresence({ connectionState: 'connected', phase: 'ready', lead: { ...lead, detail: '503 Service Unavailable' }, name: 'Paimon', now: NOW }))
      .not.toHaveProperty('needsModelSetup');
  });
});
