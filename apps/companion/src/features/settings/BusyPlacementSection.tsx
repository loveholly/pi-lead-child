import { Card, Column, Row, SegmentedControl, Text } from '@pi-lead-child/components';
import {
  BUSY_PLACEMENTS, CHAT_PLACEMENT_PREFERENCE_CAPABILITY, type BusyPlacement, type BusyPlacementDto,
} from '@pi-lead-child/protocol';
import { useState } from 'react';

import { useLocale } from '@/i18n';
import { useCompanionRuntime, useControlPlaneStore } from '@/state/CompanionStateProvider';
import { useBusyPlacement, useLeadName } from '@/state/hooks';

import { busyPlacementMessages } from './busyPlacement.messages';
import { memoryErrorText } from './memoryModel';

// 分段控件和它下面两句说明一共多宽：桌面上两段各约 240，说明两三行；手机上占满。
const CHOICE_WIDTH = 480;

// 设置 → Lead → 身份与风格 →「Lead 忙时你发的消息」（主题 11.19，用户 2026-11-09）：形象卡下面的一张独立的卡。
// 排队（缺省）和插话二选一，用输入框上「插话 / 排队」的那个分段控件；每一段下面一句说明，说明里用 Lead 的名字。
// 点了马上保存：操作层的 busy_placement.set（和 Lead 的 perform_action 同一个函数）。保存期间写「正在保存…」，不再接受点击；
// 没保存成功时卡里写原因，选中项退回保存着的那一个。旧 daemon 不按这个设置放消息时不给选。
export function BusyPlacementSection() {
  const supported = useControlPlaneStore((state) => state.capabilities.includes(CHAT_PLACEMENT_PREFERENCE_CAPABILITY));
  const locale = useLocale();
  if (!supported) {
    return <Text testID="busy-placement-unsupported" size="note" tone="muted">{busyPlacementMessages(locale).unsupported}</Text>;
  }
  return <BusyPlacementCard />;
}

function BusyPlacementCard() {
  const { busyPlacement, resource } = useBusyPlacement();
  const locale = useLocale();
  const m = busyPlacementMessages(locale);
  if (!busyPlacement) {
    return (
      <Text testID="busy-placement-loading" size="note" tone={resource?.state === 'error' ? 'danger-dark' : 'muted'}>
        {resource?.state === 'error' ? m.loadFailed(memoryErrorText(resource.error, locale)) : m.loading}
      </Text>
    );
  }
  return <BusyPlacementChoice saved={busyPlacement} />;
}

function BusyPlacementChoice({ saved }: { saved: BusyPlacementDto }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = busyPlacementMessages(locale);
  // 正在保存的那一个：保存完以后读 daemon 的值，没保存成功时退回。
  const [pending, setPending] = useState<BusyPlacement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = pending ?? saved.placement;

  const choose = (next: BusyPlacement) => {
    if (pending !== null || next === saved.placement) return;
    setPending(next);
    setError(null);
    runtime.setBusyPlacement(next)
      .catch((reason: unknown) => setError(m.failed(memoryErrorText(reason, locale))))
      .finally(() => setPending(null));
  };

  return (
    <Card testID="busy-placement-section" rounded="xl" p="page-card" gap="form-field">
      <Text size="card-title" weight="extrabold">{m.title(leadName)}</Text>
      <Column w={CHOICE_WIDTH} maxW="100%" gap="field">
        <SegmentedControl
          testID="busy-placement"
          optionTestID={(option) => `busy-placement-${option}`}
          size="sm"
          options={BUSY_PLACEMENTS.map((option) => ({ value: option, label: m.options[option] }))}
          value={value}
          onChange={choose}
        />
        {/* 每一段正下方是它的说明：两栏和两段一样平分宽度。 */}
        <Row gap="inline-item">
          {BUSY_PLACEMENTS.map((option) => (
            <Column key={option} flex={1} minW={0}>
              <Text testID={`busy-placement-note-${option}`} size="note" tone="secondary">{m.notes[option](leadName)}</Text>
            </Column>
          ))}
        </Row>
      </Column>
      {error ? <Text testID="busy-placement-error" size="note" tone="danger-dark">{error}</Text> : null}
      <Text testID="busy-placement-footnote" size="meta" tone="muted">{pending !== null ? m.saving : m.footnote}</Text>
    </Card>
  );
}
