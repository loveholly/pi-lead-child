import { Badge, Button, Column, Row, Text, TextField } from '@pi-lead-child/components';
import type { ChannelSourceSettingsDto, ChannelSubscriptionsDto } from '@pi-lead-child/protocol';
import { useEffect, useState } from 'react';

import { useLocale } from '@/i18n';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useLeadName } from '@/state/hooks';

import { channelsMessages } from './channels.messages';
import { channelErrorText } from './channelSettingsModel';

// 设置 → 消息通道里一个来源的固定订阅（2026-11-25）。固定的频道不管最近有没有对话都算订阅，消息只记录、沉淀进记忆；
// 配置里的排除名单优先，这里只读地列出来。只有能固定订阅的来源才有这一块（GET …/subscriptions 回 404 时不画）。
// 加、删都走操作层（channel_subscriptions），和 Lead 的 perform_action 是同一个函数；结果就是新的名单。
// 来源的状态变了（网关推了新的 source）时再读一次：Lead 可能刚改过名单。

const pinKey = (entry: string) => entry.trim().replace(/^#/, '').toLowerCase();

export function ChannelSubscriptionsBlock({ source }: { source: ChannelSourceSettingsDto }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = channelsMessages(locale);
  const [dto, setDto] = useState<ChannelSubscriptionsDto | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    runtime.channelSubscriptions(source.source, controller.signal)
      .then(setDto)
      .catch(() => {
        if (!controller.signal.aborted) setDto(null);
      });
    return () => controller.abort();
  }, [runtime, source]);
  if (!dto) return null;
  const id = source.source;
  const excluded = new Set(dto.excluded.map(pinKey));
  const act = (action: 'pin' | 'unpin', entry: string) => {
    setPending(true);
    setError(null);
    runtime.performUiAction('channel_subscriptions', id, action, { input: { entry } })
      .then((response) => {
        const next = response.result as ChannelSubscriptionsDto | undefined;
        if (next && Array.isArray(next.pinned)) setDto({ source: dto.source, pinned: next.pinned, excluded: next.excluded ?? dto.excluded });
        if (action === 'pin') setDraft('');
      })
      .catch((reason: unknown) => setError(m.pinFailed(channelErrorText(reason, leadName, locale))))
      .finally(() => setPending(false));
  };
  const add = () => {
    const entry = draft.trim();
    if (entry && !pending) act('pin', entry);
  };
  return (
    <Column testID={`channel-${id}-pinned`} gap="card-row" pt="card-row" borderTopWidth={1} borderTopColor="border-soft">
      <Column gap="text-stack">
        <Text size="label" weight="semibold" tone="secondary">{m.pinnedTitle}</Text>
        <Text size="secondary" tone="secondary">{m.pinnedDescription(leadName)}</Text>
      </Column>
      {dto.pinned.length ? (
        <Column testID={`channel-${id}-pinned-list`} gap="text-stack">
          {dto.pinned.map((entry) => (
            <Row key={entry} testID={`channel-${id}-pinned-row`} items="center" gap="inline-item">
              <Text flex={1} minW={0} size="secondary" mono tone="strong" numberOfLines={1}>{entry}</Text>
              {excluded.has(pinKey(entry)) ? <Badge label={m.excludedBadge} tone="muted" size="sm" /> : null}
              <Button
                testID={`channel-${id}-unpin-${entry}`}
                label={m.unpin}
                accessibilityLabel={m.unpinLabel(entry)}
                variant="ghost"
                tone="neutral"
                size="xs"
                disabled={pending}
                onPress={() => act('unpin', entry)}
              />
            </Row>
          ))}
        </Column>
      ) : <Text size="secondary" tone="secondary">{m.pinnedEmpty}</Text>}
      <Row items="center" gap="actions">
        <TextField
          testID={`channel-${id}-pin-input`}
          value={draft}
          onChangeText={(value) => {
            setDraft(value);
            setError(null);
          }}
          placeholder={m.pinnedPlaceholder}
          accessibilityLabel={m.pinnedInputLabel}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={100}
          size="sm"
          grow
          onSubmit={add}
        />
        <Button
          testID={`channel-${id}-pin`}
          label={m.pin}
          variant="outline"
          tone="neutral"
          size="sm"
          disabled={pending || !draft.trim()}
          onPress={add}
        />
      </Row>
      {dto.excluded.length ? (
        <Text testID={`channel-${id}-excluded`} size="meta" tone="secondary">{m.excludedNote(dto.excluded.join(', '))}</Text>
      ) : null}
      {error ? <Text testID={`channel-${id}-pinned-error`} size="note" tone="danger-dark">{error}</Text> : null}
    </Column>
  );
}
