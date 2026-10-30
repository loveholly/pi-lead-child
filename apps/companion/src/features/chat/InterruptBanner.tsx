import { Box, Button, Column, Icon, Row, Text } from '@pi-lead-child/components';
import type { LeadInterrupt } from '@pi-lead-child/protocol';
import { useMemo, useState } from 'react';

import { useCompanionRuntime, useControlPlaneStore } from '../../state/CompanionStateProvider';
import { openLeadInterrupts } from '../../state/control-plane/leadActivity';
import { useLeadName } from '../../state/hooks';
import { leadActivityBasisLine } from './LeadActivityBlock';
import { useOpenTicket } from './useOpenTicket';

// interrupt 级的事（Lead 事件主干 spec D10，工单 06）：在输入框上方显示横幅，用户点「知道了」之前一直在。
// 横幅只放 interrupt 级的事件。一次显示最早的一条，还有别的写「还有 N 条」；确认一条，下一条接着显示。
// 确认写回事件的处置（daemon 的 POST /v1/lead/interrupts/:seq/ack），别的客户端由推送收起。别处已处理的不再显示。
// 和会话里的警告一样：白底、细描边，左边 3px 的色条和图标表示严重程度（见 components 的 NoticeRow）。

function clock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

/** 横幅上的这件事是不是一条到点的提醒（工单 07）：是的话返回提醒的编号。 */
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
  onSnooze,
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
  // 到点的提醒（工单 07）：「10 分钟后再提醒」。
  onSnooze?: () => void;
  onOpenTicket?: (ticketId: number) => void;
}) {
  const basis = leadActivityBasisLine(interrupt, leadName);
  const meta = [clock(interrupt.at), basis, more > 0 ? `还有 ${more} 条` : null].filter(Boolean).join(' · ');
  // 提醒不是工单：横幅上不给「打开 #83」，给「10 分钟后再提醒」。
  const reminderId = interruptReminderId(interrupt);
  const ticketId = reminderId === null ? interrupt.ticketId : null;
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
          {error ? <Text size="note" tone="danger-dark">{`没有确认上：${error}`}</Text> : null}
        </Column>
        <Row items="center" gap="actions" shrink={0}>
          {ticketId && onOpenTicket ? (
            <Button label={`打开 #${ticketId}`} onPress={() => onOpenTicket(ticketId)} variant="link" size="xs" />
          ) : null}
          {reminderId !== null && onSnooze ? (
            <Button
              testID="interrupt-banner-snooze"
              label="10 分钟后再提醒"
              onPress={onSnooze}
              disabled={busy}
              variant="outline"
              tone="neutral"
              size="xs"
            />
          ) : null}
          <Button
            testID="interrupt-banner-ack"
            label="知道了"
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
  const open = useMemo(() => openLeadInterrupts(state), [state]);
  const openTicket = useOpenTicket();
  const leadName = useLeadName();
  const [pending, setPending] = useState<{ seq: number; error: string | null } | null>(null);
  const first = open[0];
  if (!first) return null;
  const run = (work: () => Promise<unknown>) => {
    setPending({ seq: first.seq, error: null });
    work().then(
      () => setPending(null),
      (error: unknown) => setPending({ seq: first.seq, error: error instanceof Error ? error.message : String(error) }),
    );
  };
  const reminderId = interruptReminderId(first);
  // 到点的提醒（工单 07）：「知道了」就是确认这条提醒，和到点卡上的「知道了」一样；提醒结束了，服务端同时收起横幅。
  // 提醒已经确认过（例如 Lead 替用户确认了）时动作会被拒绝，这时只确认横幅。
  const acknowledge = () => run(reminderId === null
    ? () => runtime.acknowledgeLeadInterrupt(first.seq)
    : () => runtime.performTicketAction(reminderId, 'ack').catch(() => runtime.acknowledgeLeadInterrupt(first.seq)));
  const snooze = reminderId === null ? undefined : () => run(() => runtime.rescheduleReminder(reminderId, { snoozeMinutes: 10 }));
  const mine = pending?.seq === first.seq ? pending : null;
  return (
    <InterruptBannerView
      interrupt={first}
      leadName={leadName}
      more={open.length - 1}
      busy={mine !== null && mine.error === null}
      error={mine?.error ?? null}
      onAcknowledge={acknowledge}
      {...(snooze ? { onSnooze: snooze } : {})}
      onOpenTicket={openTicket}
    />
  );
}
