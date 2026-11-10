import { Card, ChoiceGroup, Text } from '@pi-lead-child/components';
import type { HostBypassDto } from '@pi-lead-child/protocol';
import { useState } from 'react';

import { useLocale } from '@/i18n';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useHostBypass, useLeadName } from '@/state/hooks';

import { hostBypassMessages } from './hostBypass.messages';
import {
  HOST_BYPASS_OPTIONS, hostBypassErrorText, hostBypassOn, isHostBypassOption, type HostBypassOption,
} from './hostBypassModel';

// 设置 → 免沙箱（工单 #246 设计 5.1，主题 11.17）：「用户本人发话时免沙箱」的开关。
// 没有时限（用户 2026-11-10：「把 bypass 的时间限制去掉，也做成和 steer 一样的开关就好」）：打开以后一直开着，直到你或 Lead 关掉。
// 和「Lead 忙时你发的消息」（BusyPlacementSection，主题 11.19）同一种写法：标题，一组单选卡（关着是缺省，开着），
// 每个选项里一句说明，最后一行写选了马上保存。
// 点了马上保存：开着走操作层的 host_bypass.enable（user_direct，只有你本人能做），关着走 host_bypass.disable（Lead 也能做）。
// 保存期间写「正在保存…」，不再接受点击；没保存成功时卡里写原因，选中项退回保存着的那一个。
export function HostBypassSection() {
  const { hostBypass, resource } = useHostBypass();
  const locale = useLocale();
  const m = hostBypassMessages(locale);
  if (!hostBypass) {
    return (
      <Text testID="host-bypass-loading" size="note" tone={resource?.state === 'error' ? 'danger-dark' : 'muted'}>
        {resource?.state === 'error' ? m.loadFailed(hostBypassErrorText(resource.error, locale)) : m.loading}
      </Text>
    );
  }
  return <HostBypassChoice saved={hostBypass} />;
}

function HostBypassChoice({ saved }: { saved: HostBypassDto }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = hostBypassMessages(locale);
  // 正在保存的那一个：保存完以后读 daemon 的值，没保存成功时退回。
  const [pending, setPending] = useState<HostBypassOption | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current: HostBypassOption = hostBypassOn(saved) ? 'on' : 'off';
  const value = pending ?? current;

  const choose = (next: string) => {
    if (!isHostBypassOption(next) || pending !== null || next === current) return;
    setPending(next);
    setError(null);
    (next === 'on' ? runtime.enableHostBypass() : runtime.disableHostBypass())
      .catch((reason: unknown) => setError(m.failed(hostBypassErrorText(reason, locale))))
      .finally(() => setPending(null));
  };

  return (
    <Card testID="host-bypass-section" rounded="xl" p="page-card" gap="form-field">
      <Text size="card-title" weight="extrabold">{m.title}</Text>
      <ChoiceGroup
        variant="radio"
        testID="host-bypass"
        optionTestID={(option) => `host-bypass-${option}`}
        accessibilityLabel={m.title}
        value={value}
        disabled={pending !== null}
        onSelect={choose}
        options={HOST_BYPASS_OPTIONS.map((option) => ({ id: option, label: m.options[option], description: m.notes[option](leadName) }))}
      />
      {error ? <Text testID="host-bypass-error" size="note" tone="danger-dark">{error}</Text> : null}
      <Text testID="host-bypass-footnote" size="meta" tone="muted">{pending !== null ? m.saving : m.footnote(leadName)}</Text>
    </Card>
  );
}
