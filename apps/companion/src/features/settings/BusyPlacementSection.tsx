import { Card, ChoiceGroup, Text } from '@pi-lead-child/components';
import {
  BUSY_PLACEMENTS, CHAT_PLACEMENT_PREFERENCE_CAPABILITY, isBusyPlacement, type BusyPlacement, type BusyPlacementDto,
} from '@pi-lead-child/protocol';
import { useState } from 'react';

import { useLocale } from '@/i18n';
import { useCompanionRuntime, useControlPlaneStore } from '@/state/CompanionStateProvider';
import { useBusyPlacement, useLeadName } from '@/state/hooks';

import { busyPlacementMessages } from './busyPlacement.messages';
import { memoryErrorText } from './memoryModel';

// 设置 → Lead → 身份与风格 →「Lead 忙时你发的消息」（主题 11.19，用户 2026-11-09）：形象卡下面的一张独立的卡。
// 排队（缺省）和插话二选一，是一组单选卡（ChoiceGroup 的 radio，用户 2026-11-09：「把 tab 换成 radio 吧」）；
// 每个选项里一句说明，说明里用 Lead 的名字。
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

  const choose = (next: string) => {
    if (!isBusyPlacement(next) || pending !== null || next === saved.placement) return;
    setPending(next);
    setError(null);
    runtime.setBusyPlacement(next)
      .catch((reason: unknown) => setError(m.failed(memoryErrorText(reason, locale))))
      .finally(() => setPending(null));
  };

  return (
    <Card testID="busy-placement-section" rounded="xl" p="page-card" gap="form-field">
      <Text size="card-title" weight="extrabold">{m.title(leadName)}</Text>
      <ChoiceGroup
        variant="radio"
        testID="busy-placement"
        optionTestID={(option) => `busy-placement-${option}`}
        accessibilityLabel={m.title(leadName)}
        value={value}
        disabled={pending !== null}
        onSelect={choose}
        options={BUSY_PLACEMENTS.map((option) => ({ id: option, label: m.options[option], description: m.notes[option](leadName) }))}
      />
      {error ? <Text testID="busy-placement-error" size="note" tone="danger-dark">{error}</Text> : null}
      <Text testID="busy-placement-footnote" size="meta" tone="muted">{pending !== null ? m.saving : m.footnote}</Text>
    </Card>
  );
}
