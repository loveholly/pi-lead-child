import { Badge, Card, Column, Row, Switch, Text } from '@pi-lead-child/components';
import type { RuntimeSettingEntry, RuntimeSettingsDto } from '@pi-lead-child/protocol';
import { useState } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useLeadName, useRuntimeSettings } from '@/state/hooks';

import { memoryErrorText } from './memoryModel';

// leadName 是 Lead 的名字（useLeadName）。
export function runtimesDescription(leadName: string): string {
  return `执行工单的 agent。停用的不再接新的活，也不做核查，${leadName} 也不会再推荐它。`;
}

// 设置 → 执行 → 执行器（2026-10-19）。每个 runtime 一个开关。
// 停用以前只能对 Lead 说「不用 codex」，那句话只进了 Lead 的笔记，系统不读笔记。现在开关存在 config.json，马上生效。
export function RuntimesSection() {
  const { runtimeSettings, resource } = useRuntimeSettings();
  if (!runtimeSettings) {
    return (
      <Text testID="runtimes-loading" size="body" tone={resource?.state === 'error' ? 'danger-dark' : 'muted'}>
        {resource?.state === 'error'
          ? `读不到执行器设置：${resource.error ? memoryErrorText(resource.error) : '执行器设置没有启动'}`
          : '正在读取执行器设置…'}
      </Text>
    );
  }
  return (
    <Column testID="runtimes-section" gap="page-section">
      <RuntimeSwitches settings={runtimeSettings} />
      <ReviewerNote settings={runtimeSettings} />
    </Column>
  );
}

function RuntimeSwitches({ settings }: { settings: RuntimeSettingsDto }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = (entry: RuntimeSettingEntry, enabled: boolean) => {
    setSaving(entry.id);
    setError(null);
    runtime.updateRuntimeSettings({ runtime: entry.id, enabled })
      .catch((reason: unknown) => setError(memoryErrorText(reason)))
      .finally(() => setSaving(null));
  };
  return (
    <Card rounded="xl" p="page-card">
      <Column gap="card-row">
        {settings.runtimes.map((entry) => (
          <Row key={entry.id} testID={`runtime-row-${entry.id}`} items="center" gap="side-item">
            <Column flex={1} minW={0} gap="text-stack">
              <Row items="center" gap="inline-item">
                <Text size="card-title" weight="semibold">{entry.label}</Text>
                {entry.canReview ? <Badge label="能做只读核查" tone="neutral" size="sm" /> : null}
                {!entry.installed ? <Badge label="没有安装" tone="warning" size="sm" /> : null}
              </Row>
              <Text size="secondary" tone="secondary">
                {entry.enabled ? '在用。' : `已停用：不派活、不做核查，点名它的工单会等 ${leadName} 改派。`}
              </Text>
            </Column>
            <Switch
              testID={`runtime-switch-${entry.id}`}
              value={entry.enabled}
              disabled={saving !== null}
              onValueChange={(on) => change(entry, on)}
            />
          </Row>
        ))}
        {error ? <Text size="secondary" tone="danger-dark">{error}</Text> : null}
      </Column>
    </Card>
  );
}

// 自动核查用哪个执行器（2026-10-20 起任何执行器都能当核查员，能跑命令的优先）。它不能用时，派发时自动换下一个能用的。
// 只有所有执行器都停用时才派不出去，那时委托验收闭不了环。runtimes 里的 canReview 指这个执行器核查时能不能运行命令。
function ReviewerNote({ settings }: { settings: RuntimeSettingsDto }) {
  const leadName = useLeadName();
  const reviewer = settings.runtimes.find((entry) => entry.id === settings.reviewer.id);
  const name = reviewer?.label ?? settings.reviewer.id;
  const text = !settings.reviewer.canReview
    ? `所有执行器都停用了，自动核查派不出去。委托给 ${leadName} 验收的工单要你自己验收。`
    : reviewer?.canReview === false
      ? `自动核查用 ${name}。${name} 只能读代码，不能运行测试，核查结论来自阅读。它不能用时，自动换下一个能用的执行器。`
      : `自动核查用 ${name}。它不能用时，自动换下一个能用的执行器。`;
  return (
    <Column gap="group-label">
      <Text size="eyebrow" weight="bold" tone="secondary">自动核查</Text>
      <Card rounded="xl" p="page-card">
        <Text testID="runtimes-reviewer" size="secondary" tone={settings.reviewer.canReview ? 'secondary' : 'danger-dark'}>
          {text}
        </Text>
      </Card>
    </Column>
  );
}
