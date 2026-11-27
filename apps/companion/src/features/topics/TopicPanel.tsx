import {
  Box, Button, ChatList, Column, ConversationColumn, Density, DetailHeader, Icon, Popover, RecordRow, Row, Text, TextField,
} from '@pi-lead-child/components';
import { TOPIC_TITLE_MAX_LENGTH, type ChatFileInput, type ChatImageInput, type ChatQuoteInput, type TopicDto } from '@pi-lead-child/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { LeadComposerDock } from '@/features/chat/LeadComposerDock';
import { ConversationScopeContext } from '@/features/chat/conversationScope';
import { useMessages } from '@/i18n';
import { useCompanionRuntime, useControlPlaneStore, useWorkspaceStore } from '@/state/CompanionStateProvider';
import { useConnectionState, useLeadName, useTopic, useTopicMessageIds } from '@/state/hooks';

import {
  TopicConversationBlockView, TopicOriginQuote, useTopicConversationBlocks, useTopicConversationScope,
  type TopicConversationBlock,
} from './TopicConversation';
import { topicsMessages } from './topics.messages';

// The panel of a topic (design rules P16 and P18, theme 11.26): the title, the conversation, the input.
// On the desktop it is the right column of the workbench; on a phone width it covers the page (standalone).
// The low-frequency actions (rename, bring the conclusion back, close) are in the "more" menu of the header.
// The messages and the input are the main conversation's own components (ConversationMessage, LeadComposerDock):
// a topic gives only where a message goes and which model the picker changes.
export function TopicPanel({ topicId, onClose, standalone = false }: { topicId: number; onClose: () => void; standalone?: boolean }) {
  const m = useMessages(topicsMessages);
  const runtime = useCompanionRuntime();
  const topic = useTopic(topicId);
  const messageIds = useTopicMessageIds(topicId);
  const connected = useConnectionState() === 'connected';
  const markSeen = useWorkspaceStore((state) => state.markTopicSeen);
  // The panel shows this topic already and you clicked an entry that opens it: the header flashes (#590, theme Q-9).
  const flash = useWorkspaceStore((state) => (state.panelNudge?.panel === 'topic' ? state.panelNudge.seq : null));
  const [error, setError] = useState<string | null>(null);
  // The model on the input (theme 11.18): the topic's own model, or the main conversation's when it has none.
  // The picker changes this topic only (topic.set_model).
  const mainModel = useControlPlaneStore((state) => state.overview?.model);
  const modelSpec = topic?.model ?? mainModel ?? null;
  // The reply that the topic is writing now, if any: the menu offers to stop it.
  const answering = useControlPlaneStore((state) => messageIds.some((id) => {
    const message = state.messagesById[id];
    return message?.role === 'assistant' && message.state === 'streaming';
  }));
  // What this device showed last: a later turn marks the topic as having a new reply (the list on the left).
  const lastTurnId = topic?.lastTurnId ?? null;
  useEffect(() => {
    if (lastTurnId) markSeen(topicId, lastTurnId);
  }, [lastTurnId, markSeen, topicId]);

  // A message of this topic: the words, with the images and the files you attached. A refusal is shown above the input.
  const sendMessage = useCallback((text: string, attachments: { images: readonly ChatImageInput[]; files: readonly ChatFileInput[] }) => {
    setError(null);
    return runtime.sendTopicMessage(topicId, text, attachments).catch((reason: unknown) => {
      setError(reason instanceof Error && reason.message ? reason.message : m.actionFailed);
    });
  }, [m.actionFailed, runtime, topicId]);
  const send = useCallback((text: string, images: ChatImageInput[], _quotes?: ChatQuoteInput[], files?: ChatFileInput[]) => {
    void sendMessage(text, { images, files: files ?? [] });
  }, [sendMessage]);
  const act = useCallback((action: Promise<unknown>) => {
    setError(null);
    action.catch((reason: unknown) => setError(reason instanceof Error && reason.message ? reason.message : m.actionFailed));
  }, [m.actionFailed]);

  const title = topic?.title ?? m.topic;
  const closed = topic?.state === 'closed';
  // "Send again" on a message of this topic goes to this topic. A closed topic takes no message.
  const scope = useTopicConversationScope(closed ? null : sendMessage);
  return (
    <Column testID="topic-panel" flex={1} minH={0} bg="surface">
      <DetailHeader
        testID="topic-panel-header"
        title={title}
        flash={flash}
        more={topic ? (
          <TopicMenu
            topic={topic}
            answering={answering}
            onRename={(next) => act(runtime.renameTopic(topicId, next))}
            onBringBack={() => void sendMessage(m.bringBackRequest, { images: [], files: [] })}
            onCloseTopic={() => act(runtime.closeTopic(topicId))}
            onStop={() => act(runtime.stopTopic(topicId))}
          />
        ) : undefined}
        onClose={standalone ? undefined : onClose}
        closeLabel={m.close}
        onBack={standalone ? onClose : undefined}
        backLabel={m.back}
        dense={standalone}
      />
      <Density zone="conversation">
        <Box flex={1} minH={0}>
          <ConversationScopeContext.Provider value={scope}>
            <TopicConversationList topic={topic} topicId={topicId} messageIds={messageIds} compact={standalone} />
          </ConversationScopeContext.Provider>
        </Box>
        <LeadComposerDock
          compact={standalone}
          testID="topic-composer-column"
          contextKey={`topic:${topicId}`}
          placeholder={connected ? m.placeholder : m.connectToSend}
          disabled={!connected}
          onSend={send}
          model={modelSpec}
          picker={{
            testID: 'topic-model-picker',
            topic: { current: modelSpec, own: Boolean(topic?.model), onApply: (choice) => runtime.setTopicModel(topicId, choice) },
          }}
          above={error ? <Text testID="topic-error" size="note" tone="danger-dark">{error}</Text> : null}
          replacement={closed ? (
            <Row items="center" gap="actions">
              <Text flex={1} size="secondary" tone="secondary">{m.closedNote}</Text>
              <Button testID="topic-reopen" label={m.reopen} size="sm" variant="outline" tone="neutral" onPress={() => act(runtime.reopenTopic(topicId))} />
            </Row>
          ) : undefined}
        />
      </Density>
    </Column>
  );
}

// One row of the list: the text the topic started from (first, when there is one), then one message per row.
// The origin is a row of the list, not its header: the list rests at the bottom, and the origin belongs right above
// the first message.
type TopicListRow = TopicConversationBlock | { key: 'origin'; origin: TopicDto };

const rowKey = (row: TopicListRow) => row.key;

function TopicConversationList({ topic, topicId, messageIds, compact }: {
  topic: TopicDto | null;
  topicId: number;
  messageIds: readonly string[];
  compact: boolean;
}) {
  const m = useMessages(topicsMessages);
  const blocks = useTopicConversationBlocks(messageIds);
  // The last message that you sent: when it changes, the list goes back to the bottom.
  const lastUserMessageId = useControlPlaneStore((state) => {
    for (let index = messageIds.length - 1; index >= 0; index -= 1) {
      const message = state.messagesById[messageIds[index]!];
      if (message?.role === 'user') return message.id;
    }
    return null;
  });
  // The newest message from Lead: its avatar is the live one (theme F-5), as in the main conversation.
  const latestLeadMessageId = useControlPlaneStore((state) => {
    for (let index = messageIds.length - 1; index >= 0; index -= 1) {
      const message = state.messagesById[messageIds[index]!];
      if (message?.role === 'assistant') return message.id;
    }
    return null;
  });
  const origin = topic?.originQuote ? topic : null;
  const rows = useMemo<TopicListRow[]>(() => (origin ? [{ key: 'origin', origin }, ...blocks] : blocks), [blocks, origin]);
  const renderRow = useCallback((row: TopicListRow) => (
    <Box px="page-x">
      <ConversationColumn testID="topic-chat-column">
        {'origin' in row
          ? <TopicOriginQuote topic={row.origin} />
          : <TopicConversationBlockView block={row} compact={compact} latest={row.messageId === latestLeadMessageId} />}
      </ConversationColumn>
    </Box>
  ), [compact, latestLeadMessageId]);
  return (
    <ChatList
      key={topicId}
      testID="topic-chat-scroll"
      data={rows}
      keyExtractor={rowKey}
      renderItem={renderRow}
      extraData={latestLeadMessageId}
      followKey={lastUserMessageId}
      header={<Box pt="page-top" />}
      // spacing-exempt: the space under the conversation, 18 on a phone and 24 on the desktop, as in the main conversation
      footer={<Box pb={compact ? 18 : 24} />}
      empty={(
        <Box px="page-x">
          <ConversationColumn testID="topic-chat-column">
            <Text size="secondary" tone="secondary" align="center">{m.empty}</Text>
          </ConversationColumn>
        </Box>
      )}
    />
  );
}

// The "more" menu (P3.3: low-frequency actions are not shown by default). Rename happens in place in the menu.
function TopicMenu({ topic, answering, onRename, onBringBack, onCloseTopic, onStop }: {
  topic: TopicDto;
  answering: boolean;
  onRename: (title: string) => void;
  onBringBack: () => void;
  onCloseTopic: () => void;
  onStop: () => void;
}) {
  const m = useMessages(topicsMessages);
  const leadName = useLeadName();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(topic.title);
  return (
    <Popover
      testID="topic-more"
      label={m.more(topic.title)}
      title={topic.title}
      width={300}
      trigger={<Icon name="more" size={16} color="text-secondary" />}
    >
      {(close) => {
        const done = () => { setRenaming(false); close(); };
        if (renaming) {
          const next = draft.trim();
          return (
            <Column testID="topic-rename" gap="card-row">
              <TextField
                value={draft}
                onChangeText={setDraft}
                placeholder={m.renameTitle}
                variant="filled"
                size="sm"
                autoFocus
                maxLength={TOPIC_TITLE_MAX_LENGTH}
              />
              <Row gap="actions">
                <Button
                  testID="topic-rename-save"
                  label={m.renameSave}
                  size="sm"
                  disabled={!next || next === topic.title}
                  onPress={() => { done(); onRename(next); }}
                />
                <Button label={m.cancel} size="sm" variant="ghost" tone="neutral" onPress={() => setRenaming(false)} />
              </Row>
            </Column>
          );
        }
        return (
          <Column>
            {answering ? <RecordRow testID="topic-stop" title={m.stop} onPress={() => { done(); onStop(); }} /> : null}
            <RecordRow testID="topic-rename-open" title={m.rename} onPress={() => { setDraft(topic.title); setRenaming(true); }} />
            {topic.state === 'open' ? (
              <>
                <RecordRow
                  testID="topic-bring-back"
                  title={m.bringBack}
                  detail={m.bringBackDetail(leadName)}
                  onPress={() => { done(); onBringBack(); }}
                />
                <RecordRow
                  testID="topic-close"
                  title={m.closeTopic}
                  detail={m.closeTopicDetail}
                  onPress={() => { done(); onCloseTopic(); }}
                />
              </>
            ) : null}
          </Column>
        );
      }}
    </Popover>
  );
}
