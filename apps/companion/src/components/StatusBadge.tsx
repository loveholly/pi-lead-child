import { Badge, type BadgeTone, type BadgeVariant } from '@pi-lead-child/components';

import type { TicketPriority, TicketStatus } from '@/features/workspace/model';

type BadgeKind = TicketStatus | TicketPriority;

// 两台状态机的取值都要有色板（kernel spec §6.1/§6.2）：少一个 key，类型检查就会报错。
const TONES: Record<BadgeKind, { tone: BadgeTone; variant?: BadgeVariant }> = {
  // task stage
  draft: { tone: 'neutral' },
  ready: { tone: 'accent' },
  active: { tone: 'accent' },
  review: { tone: 'warning' },
  blocked: { tone: 'danger' },
  done: { tone: 'success' },
  cancelled: { tone: 'muted' },
  // reminder stage
  scheduled: { tone: 'neutral' },
  fired: { tone: 'warning' },
  acked: { tone: 'success' },
  // priority
  urgent: { tone: 'danger', variant: 'solid' },
  high: { tone: 'danger-tint' },
  normal: { tone: 'strong' },
  low: { tone: 'gray' },
};

// 工单状态和优先级的徽章。
export function StatusBadge({ label, tone }: { label: string; tone: BadgeKind }) {
  const { tone: badgeTone, variant } = TONES[tone];
  return <Badge label={label} tone={badgeTone} variant={variant} />;
}
