import { Text } from '@pi-lead-child/components';
import type { StandingOrderProposalDto } from '@pi-lead-child/protocol';
import { useCallback, useEffect, useState } from 'react';

import { StandingOrderProposalView } from '@/features/settings/StandingOrderProposal';
import { standingOrderErrorText } from '@/features/settings/standingOrderModel';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useConnectionPhase } from '@/state/hooks';

// 会话里的常设指令修改确认（工单 10）：Lead 提了一个更放开的修改后发这张卡。卡片只带审批号，内容和状态从
// /v1/standing-order-proposals/:id 实时读取：在设置页或者别的设备上处理过的提议，旧卡片也不会显示过期的按钮。

function errorStatus(reason: unknown): number | undefined {
  return typeof reason === 'object' && reason !== null ? (reason as { status?: number }).status : undefined;
}

export function StandingOrderChangeConfirmCard({ approval }: { approval: number }) {
  const runtime = useCompanionRuntime();
  // 连上 daemon 以后才读（刷新页面时设备可能还在重连）。
  const ready = useConnectionPhase() === 'ready';
  const [value, setValue] = useState<StandingOrderProposalDto | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => runtime.standingOrderProposal(approval, signal).then(
    (response) => { if (!signal?.aborted) setValue(response.proposal); },
    (reason: unknown) => {
      if (signal?.aborted) return;
      if (errorStatus(reason) === 404) setGone(true);
      else setError(standingOrderErrorText(reason));
    },
  ), [approval, runtime]);

  useEffect(() => {
    if (!ready) return undefined;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, ready]);

  if (gone) {
    return <Text testID={`surface-standing-order-${approval}-gone`} size="secondary" tone="secondary">找不到这个常设指令的提议。</Text>;
  }
  if (!value) {
    return error ? <Text size="secondary" tone="danger-dark">{error}</Text> : <Text size="13" tone="secondary">正在读取常设指令的提议…</Text>; // spacing-exempt: 提示文字字号
  }
  return <StandingOrderProposalView proposal={value} onChange={setValue} testID={`surface-standing-order-${approval}`} />;
}
