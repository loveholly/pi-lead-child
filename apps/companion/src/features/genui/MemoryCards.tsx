import { Button, Column, Row, Text } from '@pi-lead-child/components';
import type { MemorySwitch } from '@pi-lead-child/protocol';
import { useCallback, useEffect, useState } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useLeadName } from '@/state/hooks';

// 会话里的记忆切换确认（Lead 收到要确认的 memory_switch 后发）。卡片只带切换号，状态从
// /v1/memory/switches/:id 实时读取：已经在设置页或者别的设备上处理过的切换，旧卡片也不会显示过期的按钮。

// 结果和「不切换会怎样」按 parts 写：只有 embedding 的切换才重建索引；不切换时 daemon 把等确认的 reranker 设成「不用」。
function settledLabel(value: MemorySwitch): { label: string; tone: 'success-dark' | 'secondary' } | null {
  const embedding = value.parts.includes('embedding');
  const reranker = value.parts.includes('reranker');
  switch (value.state) {
    case 'applied':
      return { label: embedding ? '已切换，索引在后台重建' : '已切换，重排改用决策模型', tone: 'success-dark' };
    case 'rejected':
      return { label: `没有切换，${rejectedEffect(embedding, reranker)}`, tone: 'secondary' };
    case 'superseded':
      return { label: '设置又变了，这个切换作废', tone: 'secondary' };
    default:
      return null;
  }
}

function rejectedEffect(embedding: boolean, reranker: boolean): string {
  if (embedding && reranker) return 'embedding 照旧，重排改为「不用」';
  return reranker ? '重排改为「不用」' : '记忆照旧';
}

function errorStatus(reason: unknown): number | undefined {
  return typeof reason === 'object' && reason !== null ? (reason as { status?: number }).status : undefined;
}

function errorText(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : '';
  return message || '请求没有完成，请再试一次。';
}

export function MemorySwitchConfirmCard({ switch: id }: { switch: string }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const [value, setValue] = useState<MemorySwitch | null>(null);
  // daemon 只记最近的一个切换：更早的卡片读到 404。
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback((signal?: AbortSignal) => runtime.memorySwitch(id, signal).then(
    (next) => { if (!signal?.aborted) setValue(next); },
    (reason: unknown) => {
      if (signal?.aborted) return;
      if (errorStatus(reason) === 404) setGone(true);
      else setError(errorText(reason));
    },
  ), [id, runtime]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const decide = (approve: boolean) => {
    setSubmitting(true);
    setError(null);
    runtime.confirmMemorySwitch(id, approve)
      .then((response) => setValue(response.switch), (reason: unknown) => {
        setError(errorText(reason));
        // 已经处理过（409）或者作废：重新读一次，显示它现在的状态。
        void load();
      })
      .finally(() => setSubmitting(false));
  };

  if (gone) return <Text testID={`surface-memory-switch-${id}`} size="secondary" tone="secondary">这个记忆切换已经处理过了。</Text>;
  if (!value) {
    return error ? <Text size="secondary" tone="danger-dark">{error}</Text> : <Text size="13" tone="secondary">正在读取记忆切换…</Text>; // spacing-exempt: 提示文字字号
  }
  const settled = settledLabel(value);
  return (
    <Column testID={`surface-memory-switch-${value.id}`} gap="card-row">
      <Text size="card-title" weight="bold">记忆切换 · 要你确认</Text>
      <Text size="body">{value.summary}</Text>
      <Text size="secondary" tone="secondary">{value.reason}</Text>
      {value.state === 'pending' ? (
        <Column gap="card-row">
          <Text testID="surface-memory-switch-hint" size="note" tone="secondary">
            {`不切换时，${rejectedEffect(value.parts.includes('embedding'), value.parts.includes('reranker'))}。以后也可以在设置 → ${leadName} → 记忆里改。`}
          </Text>
          <Row gap="actions">
            <Button testID="surface-memory-switch-approve" label="切换" disabled={submitting} onPress={() => decide(true)} />
            <Button testID="surface-memory-switch-reject" label="先不切换" variant="outline" tone="neutral" disabled={submitting} onPress={() => decide(false)} />
          </Row>
        </Column>
      ) : null}
      {settled ? <Text testID="surface-memory-switch-result" size="label" weight="bold" tone={settled.tone}>{settled.label}</Text> : null}
      {error && value.state === 'pending' ? <Text size="note" tone="danger-dark">{error}</Text> : null}
    </Column>
  );
}
