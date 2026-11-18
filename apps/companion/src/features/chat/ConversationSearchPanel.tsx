import { Box, Button, Card, Chip, Column, IconButton, isWeb, Pressable, Row, ScrollArea, SegmentedControl, Text, TextField } from '@pi-lead-child/components';
import { useEffect, useState } from 'react';

import { useLocale } from '@/i18n';

import { formatConversationDate, formatConversationTime } from './conversationTime';
import { conversationSearchMessages } from './conversationSearch.messages';
import { senderKind } from './conversationSearch';
import { useConversationSearch, type ConversationSearchClient, type SearchEntry } from './useConversationSearch';

// 会话搜索面板（工单 #339）：浮在会话上方，不推动会话内容（会话列表不能跳）。
// Cmd/Ctrl+F 或顶栏的搜索钮打开。输入即搜；Enter、↓ 下一条，Shift+Enter、↑ 上一条，到首尾循环；Esc 关闭。
// 点一条命中：onJump 把会话滚到那条消息并高亮，面板和结果列表留在原处。
export type ConversationSearchPanelProps = {
  client: ConversationSearchClient;
  /** Lead 的名字，写在回答的发送者上。 */
  leadName: string;
  /** 跳到这一条。返回 false 说明会话里没有单独显示这条消息。 */
  onJump: (entry: SearchEntry) => Promise<boolean> | boolean;
  onClose: () => void;
};

const LIST_MAX_HEIGHT = 280;

export function ConversationSearchPanel({ client, leadName, onJump, onClose }: ConversationSearchPanelProps) {
  const locale = useLocale();
  const m = conversationSearchMessages(locale);
  const search = useConversationSearch(client);
  const { entries, active, step } = search;

  // 跳不过去时说一声：这条消息没有单独显示，或者会话的那一段没加载到。
  const [jumpNote, setJumpNote] = useState<string | null>(null);
  const jumpTo = (entry: SearchEntry | null) => {
    if (!entry) return;
    setJumpNote(null);
    Promise.resolve(onJump(entry)).then(
      (shown) => { if (!shown) setJumpNote(m.notShown); },
      () => setJumpNote(m.jumpFailed),
    );
  };
  const jump = (direction: 1 | -1) => jumpTo(step(direction));

  // web 的键盘：打开时在整页上听（输入框里按的键也会到这里）。
  useEffect(() => {
    if (!isWeb) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      // 输入法选字时的回车（和选字用的方向键）是给输入法的，不是「下一条」。
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key === 'Enter') {
        // 焦点在按钮、命中行上时，回车是在按它，不拦。
        if ((event.target as HTMLElement | null)?.closest?.('button, [role="button"]')) return;
        event.preventDefault();
        if (search.agentMode && entries.length === 0) void search.askAgent();
        else jump(event.shiftKey ? -1 : 1);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        jump(event.key === 'ArrowDown' ? 1 : -1);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  // 选中的那一条滚进结果列表的可视区。
  useEffect(() => {
    if (!isWeb || active < 0) return;
    document.querySelector('[data-testid="conversation-search-hit-active"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const sender = (entry: SearchEntry) => {
    const kind = senderKind(entry);
    return kind === 'lead' ? leadName : kind === 'you' ? m.you : m.other;
  };
  const when = (entry: SearchEntry) => {
    const date = formatConversationDate(entry.createdAt, new Date(), locale);
    return `${date} ${formatConversationTime(entry.createdAt, undefined, locale)}`.trim();
  };
  const summary = search.status === 'ready' && entries.length > 0
    ? (active >= 0 ? m.count(active + 1, search.total, search.totalCapped) : m.total(search.total, search.totalCapped))
    : '';

  return (
    <Card testID="conversation-search" variant="elevated" p="card" boxShadow="0 8px 24px rgba(0, 0, 0, 0.12)">
      <Column gap="card-section">
        <Row items="center" gap="inline-item">
          <Box grow={1} minW={0}>
            <TextField
              testID="conversation-search-input"
              value={search.query}
              onChangeText={search.setQuery}
              placeholder={search.agentMode ? m.agentPlaceholder : m.placeholder}
              accessibilityLabel={m.placeholder}
              autoFocus
              size="sm"
              returnKeyType="search"
              {...(isWeb ? {} : { onSubmit: () => (search.agentMode ? void search.askAgent() : jump(1)) })}
            />
          </Box>
          {summary ? <Text testID="conversation-search-count" size="note" tone="secondary">{summary}</Text> : null}
          <IconButton icon="arrow-up" label={m.previous} size="xs" variant="ghost" disabled={entries.length === 0} onPress={() => jump(-1)} testID="conversation-search-prev" />
          <IconButton icon="arrow-down" label={m.next} size="xs" variant="ghost" disabled={entries.length === 0} onPress={() => jump(1)} testID="conversation-search-next" />
          <IconButton icon="close" label={m.close} size="xs" variant="ghost" onPress={onClose} testID="conversation-search-close" />
        </Row>

        <Row items="center" gap="inline-item" flexWrap="wrap">
          {search.agentMode ? (
            <>
              <Button testID="conversation-search-agent-run" label={m.askAgentRun} size="xs" tone="accent" disabled={!search.query.trim() || search.status === 'loading'} onPress={() => void search.askAgent()} />
              <Button testID="conversation-search-agent-off" label={m.backToKeywords} size="xs" variant="ghost" onPress={search.stopAgent} />
            </>
          ) : (
            <>
              <SegmentedControl
                size="sm"
                value={search.mode}
                onChange={search.setMode}
                options={[{ value: 'exact', label: m.modeExact }, { value: 'fuzzy', label: m.modeFuzzy }]}
                testID="conversation-search-mode"
                optionTestID={(value) => `conversation-search-mode-${value}`}
              />
              {search.mode === 'exact' ? (
                <Chip testID="conversation-search-whole-word" label={m.wholeWord} selected={search.wholeWord} onPress={() => search.setWholeWord(!search.wholeWord)} />
              ) : null}
              <Button testID="conversation-search-agent" label={m.askAgent} icon="sparkle" size="xs" variant="soft" onPress={search.startAgent} />
            </>
          )}
        </Row>

        {jumpNote ? <Text testID="conversation-search-jump-note" size="note" tone="warning">{jumpNote}</Text> : null}
        {search.modelUnavailable ? <Text testID="conversation-search-model-unavailable" size="note" tone="warning">{m.modelUnavailable}</Text> : null}
        {search.status === 'loading' ? <Text size="note" tone="secondary">{search.agentMode ? m.agentLoading : m.loading}</Text> : null}
        {search.status === 'error' ? <Text testID="conversation-search-error" size="note" tone="danger">{m.unavailable}</Text> : null}
        {search.status === 'ready' && entries.length === 0 ? (
          <Text testID="conversation-search-empty" size="note" tone="secondary">{search.agentMode ? m.agentNone : m.noResults}</Text>
        ) : null}

        {entries.length > 0 ? (
          <Box maxH={LIST_MAX_HEIGHT}>
            <ScrollArea testID="conversation-search-results">
              <Column gap="card-row">
                {entries.map((entry, index) => (
                  <Pressable
                    key={`${entry.turnId}:${entry.role}:${index}`}
                    testID={index === active ? 'conversation-search-hit-active' : 'conversation-search-hit'}
                    role="button"
                    onPress={() => { search.setActive(index); jumpTo(entry); }}
                    feedback="highlight"
                    rounded="sm"
                    px="pill-x"
                    py="pill-y"
                    bg={index === active ? 'accent-soft' : undefined}
                  >
                    <Column gap="text-stack">
                      <Row gap="inline-item" items="center">
                        <Text size="label" weight="bold" numberOfLines={1}>{sender(entry)}</Text>
                        <Text size="note" tone="secondary">{when(entry)}</Text>
                      </Row>
                      <Text size="body" numberOfLines={2}>
                        {entry.before}
                        <Text size="body" weight="extrabold" tone="accent">{entry.matched}</Text>
                        {entry.after}
                      </Text>
                      {entry.reason ? <Text size="note" tone="secondary" numberOfLines={2}>{entry.reason}</Text> : null}
                    </Column>
                  </Pressable>
                ))}
                {!search.agentMode && entries.length < search.total ? (
                  <Button testID="conversation-search-more" label={m.loadMore} size="xs" variant="ghost" onPress={search.loadMore} />
                ) : null}
              </Column>
            </ScrollArea>
          </Box>
        ) : null}
      </Column>
    </Card>
  );
}
