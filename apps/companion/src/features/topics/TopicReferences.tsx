import { AnchoredPanel, Box, Button, Column, Dot, Icon, isWeb, Pressable, Row, Text } from '@pi-lead-child/components';
import { isSystemTurnOrigin, type TopicDto } from '@pi-lead-child/protocol';
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { EndRow } from '@/features/chat/EndRow';
import { formatConversationTime } from '@/features/chat/conversationTime';
import { useLocale, useMessages } from '@/i18n';
import { useControlPlaneStore, useWorkspaceStore } from '@/state/CompanionStateProvider';
import { useTopic, useTopics } from '@/state/hooks';

import { topicsMessages } from './topics.messages';
import { useOpenTopic } from './useOpenTopic';

// How the main conversation points at a topic (design rules P18, theme 11.26; the user chose "one line", 2026-11-25).
//   - Lead opened it with its tool: one line at the end of that reply of Lead. The system draws it from the stored
//     topic (originTurnId), not from Lead's words, so it is there whatever Lead wrote.
//   - You opened it from a selected text: one system line at the time you opened it. The older message is not
//     changed, so the list does not move (P1).
//   - The topic was closed with a conclusion: one end row at that time, with the conclusion. It expands in place.

/** A topic has a reply that this device did not show yet. */
export function useTopicHasNewReply(topic: TopicDto | null): boolean {
  return useWorkspaceStore((state) => {
    if (!topic?.lastTurnId || state.topicOpenId === topic.id) return false;
    const seen = state.topicSeenByTopic[topic.id];
    return seen !== undefined && seen !== topic.lastTurnId;
  });
}

/**
 * Keeps the seen baseline for the whole list: the last turn of each topic when this device first saw the topic.
 * Only a later turn is "new". Mounted once, by the main conversation.
 */
export function TopicSeenBaseline() {
  const topics = useTopics();
  const noteTopics = useWorkspaceStore((state) => state.noteTopics);
  useEffect(() => {
    noteTopics(topics);
  }, [noteTopics, topics]);
  return null;
}

/** One line that opens a topic: the icon, "Topic", the title, a dot when there is a new reply, "Open". */
export function TopicLink({ topic }: { topic: TopicDto }) {
  const m = useMessages(topicsMessages);
  const open = useOpenTopic();
  const active = useWorkspaceStore((state) => state.topicOpenId === topic.id);
  const fresh = useTopicHasNewReply(topic);
  const tone = active ? 'accent' : 'secondary';
  return (
    <Pressable testID={`topic-link-${topic.id}`} aria-label={m.openTopic(topic.title)} onPress={() => open(topic.id)} feedback="opacity" self="flex-start" maxW="100%">
      <Row items="center" gap="icon-label" minW={0}>
        <Icon name="branch" size={14} color={active ? 'accent-strong' : 'text-secondary'} />
        <Text size="secondary" tone={tone} shrink={0}>{m.topic}</Text>
        <Text size="secondary" weight="semibold" tone={active ? 'accent' : 'strong'} numberOfLines={1} shrink={1} minW={0}>{topic.title}</Text>
        {fresh ? (
          <Row items="center" gap="icon-label" shrink={0}>
            <Dot color="accent" />
            <Text size="secondary" tone="secondary">{m.newReply}</Text>
          </Row>
        ) : null}
        <Text size="secondary" weight="semibold" tone={active ? 'accent' : 'default'} shrink={0}>{m.open}</Text>
        <Icon name="chevron-right" size={12} color="text-muted" />
      </Row>
    </Pressable>
  );
}

/** The topics that Lead opened in this turn, drawn at the end of that reply. Nothing when there are none. */
export function TurnTopicLinks({ turnId }: { turnId: string | null }) {
  const topics = useControlPlaneStore(useShallow((state) => (turnId === null ? [] : (state.topics ?? [])
    .filter((topic) => topic.openedBy === 'lead' && topic.originTurnId === turnId))));
  if (!topics.length) return null;
  return (
    <Column testID="turn-topic-links" gap="text-stack">
      {topics.map((topic) => <TopicLink key={topic.id} topic={topic} />)}
    </Column>
  );
}

/**
 * The line of a topic that you opened from a selected text. It is the same line as in a reply of Lead (TopicLink):
 * one way to point at a topic, wherever it is (user 2026-11-25: the first build drew a system line here, which did
 * not look like the design).
 */
export function TopicOpenedLine({ topicId }: { topicId: number }) {
  const topic = useTopic(topicId);
  if (!topic) return null;
  return (
    <Box testID={`topic-opened-${topic.id}`} w="100%">
      <TopicLink topic={topic} />
    </Box>
  );
}

/**
 * The conclusion that a topic brought back: an end row with the title and the conclusion (P18.3, an end row P9.4).
 * A click expands the row in place (P9.4 "expand", P1.2: history expands in an anchored panel, as ChannelStackRow):
 * the whole conclusion, and a button that opens the topic, also a closed one (its panel is read-only then).
 * Ticket #590: the row only opened the topic. Right after a conclusion the topic's panel is usually open already, so
 * the click changed nothing; and the whole conclusion was shown nowhere, the row cuts it to one line.
 */
export function TopicConcludedRow({ topicId }: { topicId: number }) {
  const m = useMessages(topicsMessages);
  const locale = useLocale();
  const topic = useTopic(topicId);
  const openTopic = useOpenTopic();
  const [expanded, setExpanded] = useState(false);
  if (!topic?.conclusion || !topic.concludedAt) return null;
  const id = topic.id;
  const title = topic.title;
  const conclusion = topic.conclusion.trim();
  const line = conclusion.replace(/\s+/gu, ' ');
  const time = formatConversationTime(topic.concludedAt, undefined, locale);
  const row = (inPanel: boolean) => (
    <EndRow
      {...(inPanel ? { testID: `topic-concluded-${id}-collapse` } : { testID: `topic-concluded-${id}` })}
      icon="check"
      iconColor="success-dark"
      title={`${m.broughtBack} · ${title}`}
      line={line}
      meta={time}
      onPress={inPanel ? () => setExpanded(false) : () => setExpanded(true)}
      label={inPanel ? m.hideConclusion(title) : m.showConclusion(title)}
    />
  );
  return (
    <AnchoredPanel
      testID={`topic-concluded-${id}-anchor`}
      open={expanded}
      onClose={() => setExpanded(false)}
      label={m.conclusionOf(title)}
      outset="card"
      header={<Box px="card">{row(true)}</Box>}
      body={(
        <Column px="card" py="card-row" gap="card-row">
          <Text testID={`topic-concluded-${id}-text`} size="secondary" tone="strong">{conclusion}</Text>
          <Row>
            <Button
              testID={`topic-concluded-${id}-open`}
              label={m.openThisTopic}
              size="sm"
              variant="outline"
              tone="neutral"
              onPress={() => {
                setExpanded(false);
                openTopic(id);
              }}
            />
          </Row>
        </Column>
      )}
    >
      {row(false)}
    </AnchoredPanel>
  );
}

/**
 * Lead opened a topic because you asked in this conversation: the panel opens (design rules P16.4, 2026-11-25).
 * Only for a topic that appears while this page is open, that Lead opened in a turn you started, in the last minute.
 * A topic that Lead opened in a turn of its own (an event woke it) leaves its line only: a panel never opens when
 * you did not ask. Web only: on the native apps the panel is a page, and a page is not pushed without a tap.
 */
export function TopicAutoOpen() {
  const topics = useTopics();
  const open = useWorkspaceStore((state) => state.openTopic);
  const known = useRef<Set<number> | null>(null);
  const askedByUser = useControlPlaneStore(useShallow((state) => topics
    .filter((topic) => {
      const origin = topic.originTurnId ? state.turnsById[topic.originTurnId] : undefined;
      return topic.openedBy === 'lead' && origin !== undefined && !isSystemTurnOrigin(origin.originKind);
    })
    .map((topic) => topic.id)));
  useEffect(() => {
    if (known.current === null) {
      known.current = new Set(topics.map((topic) => topic.id));
      return;
    }
    for (const topic of topics) {
      if (known.current.has(topic.id)) continue;
      known.current.add(topic.id);
      const fresh = Date.now() - Date.parse(topic.createdAt) < 60_000;
      if (isWeb && fresh && topic.state === 'open' && askedByUser.includes(topic.id)) open(topic.id);
    }
  }, [askedByUser, open, topics]);
  return null;
}
