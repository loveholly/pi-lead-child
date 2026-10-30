// 侧栏的通知卡（2026-10-15 用户决定，Jarvis 模式）：给用户的事由 Lead 决定怎样告诉他，系统自己不往界面上推。
// 侧栏只放 Lead 决定推给他的（notify_user 写的 lead_notice），和 Lead 不能工作时系统兜底推的。
// 别的通知（提醒、等他验收……）由 Lead 在会话里说。
import type { NotificationDto } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { userOutboxNotifications } from './notificationOutbox';

function notification(id: number, overrides: Partial<NotificationDto>): NotificationDto {
  return {
    id, ticketId: null, kind: 'reminder', dedupKey: null, urgency: 'immediate', title: `n${id}`, body: '',
    state: 'pending', createdAt: '2026-10-15T08:00:00.000Z', deliveredAt: null, deliveredVia: null, ackedAt: null,
    ...overrides,
  };
}

describe('the notification outbox in the rail', () => {
  it('shows what Lead chose to push and what the fallback pushed, nothing else', () => {
    const shown = userOutboxNotifications([
      notification(1, { kind: 'reminder' }),
      notification(2, { kind: 'lead_notice', state: 'delivered', deliveredVia: 'fallback' }),
      notification(3, { kind: 'lead_unavailable', state: 'delivered', deliveredVia: 'fallback' }),
      notification(4, { kind: 'review_passed', state: 'delivered', deliveredVia: 'lead' }),
      notification(5, { kind: 'reminder', state: 'delivered', deliveredVia: 'fallback' }),
    ]);
    expect(shown.map((item) => item.id)).toEqual([2, 3, 5]);
  });
});
