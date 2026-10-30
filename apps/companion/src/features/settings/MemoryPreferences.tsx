import {
  Button, Card, Column, Icon, Popover, Pressable, RecordRow, Row, Text, TextField,
} from '@pi-lead-child/components';
import {
  CORE_MEMORY_CONTENT_MAX, CORE_MEMORY_TITLE_MAX,
  type CoreMemoryEntryDto, type MemoryInvalidatedFactDto,
} from '@pi-lead-child/protocol';
import { useState, type ReactNode } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useLeadName, useMemoryPreferences } from '@/state/hooks';

import {
  changeIdOf, INVALIDATED_HINT, invalidatedFactLine, invalidatedFactSource, memoryErrorText, preferenceChangeLine, preferenceFormProblem,
  preferenceReasonLine, preferencesEffectNote, preferencesEmptyNote, preferencesFull, preferencesHint, preferencesUsageLabel, preferenceUpdateInput,
  type PreferenceForm,
} from './memoryModel';

// 设置 → 记忆里用户自己管的两样（2026-10-29，.scratch/hindsight-primary-memory/spec.md D5、D15）：
//   - 常驻偏好：每一条的标题、正文、最近一次谁在什么时候改的、依据。能改（就地编辑）、能删、能撤销最近一次改动。
//     界面上只叫「常驻偏好」，不分类别，也不出现「笔记」这类说法（用户：「这里就是记忆偏好」）。
//   - Hindsight 里最近失效的事实：原文、来源、依据、谁、什么时候，每条能恢复。
// 改动都是操作层的操作（runtime.memoryAction），和 Lead 的 perform_action 同一个函数。不弹确认（用户 2026-10-29：
// 不要什么都要审批）：删掉以后原地留一行「已删掉 · 撤销」（撤销提示），恢复和撤销本来就能再改回去。
// 低频操作收起：每条偏好的操作在行尾的「⋯」里；失效的事实整块收起，点开才列出。

// 设置 → 记忆的一组：小标题、右边的一个短值（例如字数）、下面一句说明。
export function MemoryGroup({ title, hint, aside, children }: {
  title: string;
  hint?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Column gap="group-label">
      <Column gap="text-stack">
        <Row items="baseline" gap="inline-item">
          <Text flex={1} size="eyebrow" weight="bold" tone="secondary">{title}</Text>
          {aside}
        </Row>
        {hint ? <Text size="note" tone="muted">{hint}</Text> : null}
      </Column>
      {children}
    </Column>
  );
}

type Message = { text: string; error: boolean };

// 删掉的那一条：原地留一行，带「撤销」，直到离开这一页。index 是删之前的位置。
type Removed = { entry: CoreMemoryEntryDto; index: number; changeId: number | null };

// 「常驻偏好」卡片。旧 daemon 没有 /v1/memory/preferences（404）时整块不显示。
export function MemoryPreferences() {
  const { memoryPreferences: preferences, resource } = useMemoryPreferences();
  const leadName = useLeadName();
  const [removed, setRemoved] = useState<Removed[]>([]);
  if (!preferences) {
    if (resource?.state === 'error') {
      return (
        <Text testID="memory-preferences-error" size="note" tone="danger-dark">
          {`读不到常驻偏好：${resource.error ? memoryErrorText(resource.error) : '记忆服务的控制没有启动'}`}
        </Text>
      );
    }
    if (!resource || resource.state === 'unsupported') return null;
    return <Text testID="memory-preferences-loading" size="note" tone="muted">正在读取常驻偏好…</Text>;
  }
  // 删掉的行插回原来的位置。撤销以后重建的那一条编号不同，重取后它出现在列表里，这一行就去掉了。
  const rows: Array<{ kind: 'entry'; entry: CoreMemoryEntryDto } | { kind: 'removed'; removed: Removed }> =
    preferences.entries.map((entry) => ({ kind: 'entry' as const, entry }));
  for (const item of [...removed].sort((a, b) => a.index - b.index)) {
    if (preferences.entries.some((entry) => entry.id === item.entry.id)) continue;
    rows.splice(Math.min(item.index, rows.length), 0, { kind: 'removed', removed: item });
  }
  const forget = (id: number) => setRemoved((current) => current.filter((item) => item.entry.id !== id));
  return (
    <MemoryGroup
      title="常驻偏好"
      hint={preferencesHint(leadName)}
      aside={(
        <Text testID="memory-preferences-usage" size="meta" mono tone={preferencesFull(preferences) ? 'warning-dark' : 'secondary'}>
          {preferencesUsageLabel(preferences)}
        </Text>
      )}
    >
      <Card testID="memory-preferences" rounded="xl" overflow="hidden">
        {rows.length ? rows.map((row, index) => (row.kind === 'entry' ? (
          <PreferenceRow
            key={row.entry.id}
            entry={row.entry}
            first={index === 0}
            leadName={leadName}
            onDeleted={(changeId) => setRemoved((current) => [
              ...current.filter((item) => item.entry.id !== row.entry.id),
              { entry: row.entry, index, changeId },
            ])}
          />
        ) : (
          <RemovedRow key={`removed-${row.removed.entry.id}`} removed={row.removed} first={index === 0} onRestored={() => forget(row.removed.entry.id)} />
        ))) : (
          <Column px="page-card" py="row-y">
            <Text testID="memory-preferences-empty" size="body" tone="secondary">{preferencesEmptyNote(leadName)}</Text>
          </Column>
        )}
        <Column px="page-card" py="row-y" borderTopWidth={1} borderTopColor="border-soft">
          <Text testID="memory-preferences-effect" size="note" tone="muted">{preferencesEffectNote(leadName)}</Text>
        </Column>
      </Card>
    </MemoryGroup>
  );
}

function PreferenceRow({ entry, first, leadName, onDeleted }: {
  entry: CoreMemoryEntryDto;
  first: boolean;
  leadName: string;
  onDeleted: (changeId: number | null) => void;
}) {
  const runtime = useCompanionRuntime();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<PreferenceForm>({ title: entry.title, content: entry.content });
  // 正在做的操作：按钮写「正在……」，同一条的其他操作停用（P5.4）。
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const change = entry.lastChange;
  const reason = preferenceReasonLine(entry);
  const undo = change && (change.canUndo || change.undoBlocked) ? change : null;

  const run = (busy: string, perform: () => Promise<void>) => {
    setPending(busy);
    setMessage(null);
    perform()
      .catch((error: unknown) => setMessage({ text: memoryErrorText(error), error: true }))
      .finally(() => setPending(null));
  };
  const startEdit = () => {
    setForm({ title: entry.title, content: entry.content });
    setMessage(null);
    setEditing(true);
  };
  const save = () => {
    const problem = preferenceFormProblem(form);
    if (problem) {
      setMessage({ text: problem, error: true });
      return;
    }
    const input = preferenceUpdateInput(entry, form);
    if (!input) {
      setEditing(false);
      return;
    }
    run('正在保存…', async () => {
      await runtime.memoryAction('core_memory', String(entry.id), 'update', input);
      setEditing(false);
      setMessage({ text: '已保存。', error: false });
    });
  };
  const remove = () => run('正在删掉…', async () => {
    const result = await runtime.memoryAction('core_memory', String(entry.id), 'delete');
    onDeleted(changeIdOf(result));
  });
  const undoLast = () => {
    if (!change) return;
    run('正在撤销…', async () => {
      await runtime.memoryAction('core_memory_change', String(change.changeId), 'undo');
      setMessage({ text: '已撤销上一次改动。', error: false });
    });
  };

  return (
    <Column
      testID={`memory-preference-${entry.id}`}
      px="page-card"
      py="row-y"
      gap="card-row"
      borderTopWidth={first ? 0 : 1}
      borderTopColor="border-soft"
    >
      {editing ? (
        <Column gap="field">
          <TextField
            testID={`memory-preference-title-input-${entry.id}`}
            accessibilityLabel="标题"
            value={form.title}
            onChangeText={(title) => setForm((current) => ({ ...current, title }))}
            placeholder="标题"
            variant="filled"
            size="sm"
            maxLength={CORE_MEMORY_TITLE_MAX}
            autoFocus
          />
          <TextField
            testID={`memory-preference-content-input-${entry.id}`}
            accessibilityLabel="内容"
            value={form.content}
            onChangeText={(content) => setForm((current) => ({ ...current, content }))}
            placeholder="内容"
            variant="filled"
            size="sm"
            multiline
            height={112}
            maxLength={CORE_MEMORY_CONTENT_MAX}
          />
          <Row gap="actions" flexWrap="wrap">
            <Button testID={`memory-preference-save-${entry.id}`} label={pending ?? '保存'} size="sm" disabled={pending !== null} onPress={save} />
            <Button testID={`memory-preference-cancel-${entry.id}`} label="取消" size="sm" variant="ghost" tone="neutral" disabled={pending !== null}
              onPress={() => { setEditing(false); setMessage(null); }} />
          </Row>
        </Column>
      ) : (
        <Row items="flex-start" gap="side-item">
          <Column flex={1} minW={0} gap="card-row">
            <Column gap="text-stack">
              <Text testID={`memory-preference-title-${entry.id}`} size="card-title" weight="semibold">{entry.title}</Text>
              <Text testID={`memory-preference-content-${entry.id}`} size="body">{entry.content}</Text>
            </Column>
            <Column gap="text-stack">
              <Text testID={`memory-preference-change-${entry.id}`} size="meta" tone="secondary">{preferenceChangeLine(entry, leadName)}</Text>
              {reason ? <Text testID={`memory-preference-reason-${entry.id}`} size="secondary" tone="secondary">{reason}</Text> : null}
            </Column>
          </Column>
          <Popover
            testID={`memory-preference-more-${entry.id}`}
            label={`「${entry.title}」的操作：改、删掉${undo ? '、撤销上一次改动' : ''}`}
            title={entry.title}
            width={300}
            trigger={<Icon name="more" size={16} color="text-secondary" />}
          >
            {(close) => (
              <Column>
                <RecordRow
                  testID={`memory-preference-edit-${entry.id}`}
                  title="改"
                  detail="就地改标题和内容"
                  onPress={pending === null ? () => { close(); startEdit(); } : undefined}
                />
                <RecordRow
                  divider
                  testID={`memory-preference-delete-${entry.id}`}
                  title="删掉"
                  detail="删掉以后，这一页上可以撤销"
                  onPress={pending === null ? () => { close(); remove(); } : undefined}
                />
                {undo ? (
                  // 现在不能撤销时这一行不能点，写明原因（P5.8，原因来自 daemon 的同一个判断）。
                  <RecordRow
                    divider
                    testID={`memory-preference-undo-${entry.id}`}
                    title="撤销上一次改动"
                    detail={undo.canUndo ? preferenceChangeLine(entry, leadName) : undo.undoBlocked ?? ''}
                    onPress={undo.canUndo && pending === null ? () => { close(); undoLast(); } : undefined}
                  />
                ) : null}
              </Column>
            )}
          </Popover>
        </Row>
      )}
      {pending && !editing ? <Text testID={`memory-preference-pending-${entry.id}`} size="note" tone="secondary">{pending}</Text> : null}
      {message ? (
        <Text testID={`memory-preference-message-${entry.id}`} size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text>
      ) : null}
    </Column>
  );
}

// 删掉的那一条：标题划掉，「已删掉」，后面是「撤销」（撤销提示，不弹确认）。
function RemovedRow({ removed, first, onRestored }: { removed: Removed; first: boolean; onRestored: () => void }) {
  const runtime = useCompanionRuntime();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { entry, changeId } = removed;
  const restore = () => {
    if (changeId === null) return;
    setBusy(true);
    setError(null);
    runtime.memoryAction('core_memory_change', String(changeId), 'undo')
      .then(onRestored, (reason: unknown) => setError(memoryErrorText(reason)))
      .finally(() => setBusy(false));
  };
  return (
    <Column
      testID={`memory-preference-removed-${entry.id}`}
      px="page-card"
      py="row-y"
      gap="text-stack"
      borderTopWidth={first ? 0 : 1}
      borderTopColor="border-soft"
    >
      <Row items="center" gap="inline-item">
        <Text flex={1} minW={0} size="card-title" tone="muted" numberOfLines={1} textDecorationLine="line-through">{entry.title}</Text>
        <Text size="meta" tone="secondary">已删掉</Text>
        {changeId !== null ? (
          <Button testID={`memory-preference-restore-${entry.id}`} label={busy ? '正在撤销…' : '撤销'} variant="link" tone="neutral" size="xs" disabled={busy} onPress={restore} />
        ) : null}
      </Row>
      {error ? <Text testID={`memory-preference-restore-error-${entry.id}`} size="note" tone="danger-dark">{error}</Text> : null}
    </Column>
  );
}

// Hindsight 部分里「最近失效的事实」：失效着的事实不被召回。整块收起，点开一条一行，每条能恢复。
// 没有失效的事实时调用方不画这一块。
export function InvalidatedFacts({ facts }: { facts: readonly MemoryInvalidatedFactDto[] }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const restore = (fact: MemoryInvalidatedFactDto) => {
    setBusy(fact.memoryId);
    setErrors((current) => {
      const next = { ...current };
      delete next[fact.memoryId];
      return next;
    });
    runtime.memoryAction('memory_fact', fact.memoryId, 'restore')
      .catch((reason: unknown) => setErrors((current) => ({ ...current, [fact.memoryId]: memoryErrorText(reason) })))
      .finally(() => setBusy(null));
  };
  return (
    <Column testID="memory-invalidated" p="page-card" gap="card-row">
      <Pressable
        testID="memory-invalidated-toggle"
        onPress={() => setOpen(!open)}
        feedback="none"
        aria-label={open ? '收起最近失效的事实' : '展开最近失效的事实'}
        aria-expanded={open}
      >
        <Row items="center" gap="inline-item">
          <Text size="card-title" weight="semibold">最近失效的事实</Text>
          <Text testID="memory-invalidated-count" flex={1} size="meta" tone="muted">{`${facts.length} 条`}</Text>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color="text-secondary" weight="semibold" />
        </Row>
      </Pressable>
      {open ? (
        <Column gap="card-row">
          <Text size="secondary" tone="secondary">{INVALIDATED_HINT}</Text>
          {facts.map((fact) => {
            const source = invalidatedFactSource(fact);
            const error = errors[fact.memoryId];
            return (
              <Row key={fact.memoryId} testID={`memory-fact-${fact.memoryId}`} items="flex-start" gap="side-item" pt="card-row" borderTopWidth={1} borderTopColor="border-soft">
                <Column flex={1} minW={0} gap="text-stack">
                  <Text testID={`memory-fact-text-${fact.memoryId}`} size="body" tone={fact.text ? 'default' : 'muted'}>{fact.text ? `「${fact.text}」` : '读不到原文'}</Text>
                  <Text testID={`memory-fact-meta-${fact.memoryId}`} size="meta" tone="secondary">
                    {[invalidatedFactLine(fact, leadName), source].filter(Boolean).join(' · ')}
                  </Text>
                  {fact.reason.trim() ? <Text testID={`memory-fact-reason-${fact.memoryId}`} size="secondary" tone="secondary">{`依据：${fact.reason.trim()}`}</Text> : null}
                  {error ? <Text testID={`memory-fact-error-${fact.memoryId}`} size="note" tone="danger-dark">{error}</Text> : null}
                </Column>
                <Button
                  testID={`memory-fact-restore-${fact.memoryId}`}
                  label={busy === fact.memoryId ? '正在恢复…' : '恢复'}
                  variant="outline"
                  tone="neutral"
                  size="xs"
                  disabled={busy !== null}
                  onPress={() => restore(fact)}
                />
              </Row>
            );
          })}
        </Column>
      ) : null}
    </Column>
  );
}
