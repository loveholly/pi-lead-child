import { Box, Button, Column, Icon, Row, Text } from '@pi-lead-child/components';
import type { LeadInterrupt } from '@pi-lead-child/protocol';
import { useMemo, useState } from 'react';

import { intlLocale, useLocale, type Locale } from '@/i18n';

import { useCompanionRuntime, useControlPlaneStore } from '../../state/CompanionStateProvider';
import { openLeadInterrupts } from '../../state/control-plane/leadActivity';
import { useLeadName } from '../../state/hooks';
import { conversationMessages } from './conversation.messages';
import { leadActivityBasisLine } from './LeadActivityBlock';
import { useOpenTicket } from './useOpenTicket';

// interrupt 级的事（Lead 事件主干 spec D10，工单 06）：在输入框上方显示横幅，用户点「知道了」之前一直在。
// 横幅只放 interrupt 级的事件。一次显示最早的一条，还有别的写「还有 N 条」；确认一条，下一条接着显示。
// 确认写回事件的处置（daemon 的 POST /v1/lead/interrupts/:seq/ack），别的客户端由推送收起。别处已处理的不再显示。
// 和会话里的警告一样：白底、细描边，左边 3px 的色条和图标表示严重程度（见 components 的 NoticeRow）。
// A due reminder is not shown here: the conversation already has its due card (ReminderFireCard), with Got it and
// the snooze options. The banner showed the same reminder a second time.

// 两种语言都写 24 小时制（设计规范 P14.2）。
function clock(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(intlLocale(locale), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

/** Is this interrupt a due reminder? If so, returns the reminder's id. The banner skips these. */
export function interruptReminderId(interrupt: Pick<LeadInterrupt, 'kind' | 'entityKey'>): number | null {
  if (interrupt.kind !== 'timer.fired') return null;
  const match = /^reminder:(\d+)$/u.exec(interrupt.entityKey);
  return match ? Number(match[1]) : null;
}

export function InterruptBannerView({
  interrupt,
  leadName,
  more,
  busy = false,
  error = null,
  onAcknowledge,
  onOpenTicket,
}: {
  interrupt: LeadInterrupt;
  /** Lead 的名字（useLeadName）。依据里的硬性规则要用。 */
  leadName: string;
  /** 后面还有几条没确认的。 */
  more: number;
  busy?: boolean;
  error?: string | null;
  onAcknowledge: () => void;
  onOpenTicket?: (ticketId: number) => void;
}) {
  const locale = useLocale();
  const m = conversationMessages(locale).interrupt;
  const basis = leadActivityBasisLine(interrupt, leadName, locale);
  const meta = [clock(interrupt.at, locale), basis, more > 0 ? m.more(more) : null].filter(Boolean).join(' · ');
  const ticketId = interrupt.ticketId;
  return (
    <Column
      testID="interrupt-banner"
      w="100%"
      mb={8} // spacing-exempt: 输入框上方的横幅间距
      bg="surface"
      borderWidth={1}
      borderColor="border-soft"
      borderLeftWidth={3}
      borderLeftColor="warning"
      rounded="md"
      px="banner-x"
      py="banner-y"
      gap="card-row"
    >
      <Row items="flex-start" gap="side-item">
        {/* spacing-exempt: 光学对齐 */}
        <Box pt={2} shrink={0}>
          <Icon name="warning" size={14} color="warning" />
        </Box>
        <Column flex={1} minW={0} gap="text-stack">
          <Text testID="interrupt-banner-text" size="card-title" weight="semibold" numberOfLines={3}>{interrupt.summary}</Text>
          {interrupt.rootCause?.message ? (
            <Text size="secondary" tone="secondary" numberOfLines={2}>{interrupt.rootCause.message}</Text>
          ) : null}
          {meta ? <Text testID="interrupt-banner-meta" size="meta" tone="secondary" numberOfLines={1}>{meta}</Text> : null}
          {error ? <Text size="note" tone="danger-dark">{m.notAcknowledged(error)}</Text> : null}
        </Column>
        <Row items="center" gap="actions" shrink={0}>
          {ticketId && onOpenTicket ? (
            <Button label={m.open(ticketId)} onPress={() => onOpenTicket(ticketId)} variant="link" size="xs" />
          ) : null}
          <Button
            testID="interrupt-banner-ack"
            label={m.acknowledge}
            onPress={onAcknowledge}
            disabled={busy}
            variant="solid"
            tone="accent"
            size="xs"
          />
        </Row>
      </Row>
    </Column>
  );
}

export function InterruptBanner() {
  const runtime = useCompanionRuntime();
  const state = useControlPlaneStore((value) => value.leadActivity);
  const open = useMemo(() => openLeadInterrupts(state).filter((item) => interruptReminderId(item) === null), [state]);
  const openTicket = useOpenTicket();
  const leadName = useLeadName();
  const [pending, setPending] = useState<{ seq: number; error: string | null } | null>(null);
  const first = open[0];
  if (!first) return null;
  const acknowledge = () => {
    setPending({ seq: first.seq, error: null });
    runtime.acknowledgeLeadInterrupt(first.seq).then(
      () => setPending(null),
      (error: unknown) => setPending({ seq: first.seq, error: error instanceof Error ? error.message : String(error) }),
    );
  };
  const mine = pending?.seq === first.seq ? pending : null;
  return (
    <InterruptBannerView
      interrupt={first}
      leadName={leadName}
      more={open.length - 1}
      busy={mine !== null && mine.error === null}
      error={mine?.error ?? null}
      onAcknowledge={acknowledge}
      onOpenTicket={openTicket}
    />
  );
}
