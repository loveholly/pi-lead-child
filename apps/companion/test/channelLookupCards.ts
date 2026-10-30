import type { ChannelCardDto, ChannelLookupDto } from '@pi-lead-child/protocol';

// 带代查的通道卡的测试数据（Slack 代查与按信心代回 spec D9，工单 05）。按本地时间造，测试不依赖机器的时区。
// 三张样例卡（已自动回复、问你、没查到）是工单 05 验收要的三种；带 lookup 的真实数据要等 hub（工单 04）。

/** 本地时间 2026-10-20 hh:mm 的 ISO 字符串。 */
export const localAt = (hour: number, minute: number) => new Date(2026, 9, 20, hour, minute).toISOString();
/** 测试里「现在」：14:35，代查在 14:32 查完。 */
export const LOOKUP_NOW = new Date(2026, 9, 20, 14, 35);

export function lookupDto(overrides: Partial<ChannelLookupDto> = {}): ChannelLookupDto {
  return {
    id: 31, state: 'finished', playbook: 'lookup', repos: ['acme/webhooks'], ticketId: 482, ownerName: 'Leo',
    startedAt: localAt(14, 30), finishedAt: localAt(14, 32),
    result: {
      found: 'yes',
      answer: '订单 123 的 webhook 没有触发：订单在 14:02 被标成测试单，dispatcher 跳过测试单（src/dispatch/filter.ts）。',
      sources: [
        {
          via: 'local', repo: 'acme/webhooks', path: 'src/dispatch/filter.ts', startLine: 12, endLine: 18,
          quote: 'if (order.isTest) return skip("test order");', ref: 'a1b2c3d', verified: true,
        },
        {
          via: 'github', repo: 'acme/webhooks', path: 'docs/dispatch.md', startLine: 40, endLine: 44,
          quote: 'Test orders never trigger webhooks.', ref: 'main', verified: true,
        },
      ],
      checked: ['acme/webhooks src/dispatch/', 'acme/webhooks docs/'],
      caveats: ['没有查生产日志，只看了代码和文档'],
      connectionSources: [], actions: [],
    },
    review: null,
    reads: {
      count: 3,
      items: [
        { tool: 'search', repo: 'acme/webhooks', bytes: 1200, at: localAt(14, 30) },
        { tool: 'read_file', repo: 'acme/webhooks', path: 'src/dispatch/filter.ts', lines: [1, 80], ref: 'a1b2c3d', bytes: 2400, at: localAt(14, 31) },
        { tool: 'read_file', repo: 'acme/webhooks', path: '.env', bytes: 0, refused: '禁止名单里的文件', at: localAt(14, 31) },
      ],
    },
    confidence: {
      value: 0.71, threshold: 0.85,
      checks: [
        { id: 'evidence_verified', label: '依据核实', status: 'pass', value: null, detail: '2/2 处出处在读到的内容里' },
        { id: 'fulfills_request', label: '做到了所求', status: 'pass', value: null, detail: '' },
        { id: 'grounded', label: '有依据', status: 'weak', value: null, detail: '出处说明了跳过测试单，没有说明订单为什么被标成测试单' },
        { id: 'ask_kind', label: '理解了请求', status: 'pass', value: 0.8, detail: '' },
      ],
      vetoes: [],
      calibration: { bucket: 0.7, samples: 15, agreed: 14, minSamples: 20 },
    },
    reply: { decision: 'ask_user', reasons: ['信心 0.71 低于自动门槛 0.85'], at: localAt(14, 32) },
    audience: { label: '#proj-x', externalShared: false },
    newerMessages: 0,
    deniedReasons: [],
    error: null,
    ...overrides,
  };
}

export function lookupCard(overrides: Partial<ChannelCardDto> = {}, lookup: Partial<ChannelLookupDto> = {}): ChannelCardDto {
  return {
    id: 12, version: 4, source: 'slack', sourceLabel: 'Slack', objectKey: 'slack:C0PROJX:1729405800.000100', laneLabel: '#proj-x',
    sender: { id: 'U0ZHANG', name: '张三', trust: 'colleague' }, excerpt: '订单 123 的 webhook 为什么没触发？', messageCount: 1,
    delivery: 'card', state: 'open',
    draft: { text: '订单 123 在 14:02 被标成了测试单，测试单不触发 webhook（见 src/dispatch/filter.ts）。', drafter: 'lookup' },
    gate: null,
    lookup: lookupDto(lookup), handling: null,
    sentText: null, snoozedUntil: null, revokeUntil: null, resolvedAt: null,
    actions: ['send_draft', 'send_edited', 'reply_myself', 'dismiss'],
    createdAt: localAt(14, 29), updatedAt: localAt(14, 32),
    ...overrides,
  };
}

/** 问你：查到了，信心 0.71 低于门槛 0.85，草稿交给你决定。 */
export const askYouCard = (): ChannelCardDto => lookupCard();

/** 已自动回复：信心 0.93 过了冷启动门槛 0.90，带披露前缀发出，14:43 前可以撤回。 */
export const autoRepliedCard = (): ChannelCardDto => lookupCard({
  id: 13, state: 'auto_replied', draft: null,
  sentText: 'Fairy (Assistant) · auto-reply for Leo\n订单 123 在 14:02 被标成了测试单，测试单不触发 webhook（见 src/dispatch/filter.ts）。',
  revokeUntil: localAt(14, 43), resolvedAt: localAt(14, 33), actions: ['undo_auto_reply'], updatedAt: localAt(14, 33),
}, {
  confidence: {
    value: 0.93, threshold: 0.9,
    checks: [
      { id: 'evidence_verified', label: '依据核实', status: 'pass', value: null, detail: '' },
      { id: 'fulfills_request', label: '做到了所求', status: 'pass', value: null, detail: '' },
      { id: 'grounded', label: '有依据', status: 'pass', value: null, detail: '' },
      { id: 'ask_kind', label: '理解了请求', status: 'pass', value: 0.93, detail: '' },
    ],
    vetoes: [],
    calibration: { bucket: 0.9, samples: 4, agreed: 4, minSamples: 20 },
  },
  reply: { decision: 'auto_send', reasons: ['信心 0.93 达到冷启动门槛 0.90，出处都核实过'], at: localAt(14, 33) },
});

/** 没查到：卡上写明查过哪些地方，交给你。 */
export const notFoundCard = (): ChannelCardDto => lookupCard({
  id: 14, excerpt: '退款 webhook 的签名密钥多久轮换一次？', draft: null,
  actions: ['reply_myself', 'dismiss'],
}, {
  id: 33, ticketId: 484,
  result: {
    found: 'no', answer: '', sources: [],
    checked: ['acme/webhooks src/signing/', 'acme/webhooks docs/', 'GitHub 代码搜索 rotate signing key'],
    caveats: [], connectionSources: [], actions: [],
  },
  reads: { count: 5, items: [] },
  confidence: null,
  reply: { decision: 'hand_over', reasons: ['没查到，交给你'], at: localAt(14, 32) },
});
