import { AnchoredPanel, Badge, Box, Card, GroupList, Icon, Pressable, Spinner, Text, type GroupEntry } from '@pi-lead-child/components';
import type { ChannelCardDto } from '@pi-lead-child/protocol';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useLocale, useMessages } from '@/i18n';

import { useControlPlaneStore } from '../../state/CompanionStateProvider';
import { channelCardView, clockWords } from './channelCard';
import { channelCardMessages } from './channelCard.messages';
import { ChannelEndRow, channelLatestLine, channelPlainLine } from './ChannelMessageCard';
import { channelStackRole, type ChannelStackEntry } from './channelStack';

// 同一个外部对话里连续的几条合成的一行（工单 #537，视觉稿方案 2b；分组规则见 ./channelStack）。
// 这一行和结束行（ChannelEndRow）一模一样：外面是最新的一张卡最新的一条，只在时间前面多一个徽标
// （Badge xs muted：copy 图标 12 和「+N」，N 是叠起来的其余条数）。最新的卡还在「回答中」时，图标列是转圈，结果写「回答中」。
// 点这一行在原位置打开锚定浮层（AnchoredPanel），头就是这一行，下面是 GroupList，每条一行；点头或者点外面收起，会话不跳。
export function ChannelStackRow({ cards, entries, now }: { cards: readonly ChannelCardDto[]; entries: readonly ChannelStackEntry[]; now?: Date }) {
  const locale = useLocale();
  const m = useMessages(channelCardMessages).card;
  const [open, setOpen] = useState(false);
  const top = cards.at(-1)!;
  const role = channelStackRole(top, now ?? new Date());
  const replying = role === 'replying';
  const more = Math.max(0, entries.length - 1);
  const senders = new Set(entries.map((entry) => entry.sender));
  const byId = new Map(cards.map((card) => [card.id, card]));
  const id = top.id;
  const outcome = replying ? null : channelCardView(top, now, locale).folded?.outcome ?? null;
  const outcomeID = (expanded: boolean) => (expanded ? {} : { testID: `channel-stack-${id}-outcome` });
  const row = (expanded: boolean) => (
    <ChannelEndRow
      open={expanded}
      lead={replying ? <Spinner size={12} /> : <Icon name="check" size={13} color="success" />}
      name={top.sender.name}
      line={channelLatestLine(top, m)}
      {...(expanded ? {} : { lineTestID: `channel-stack-${id}-line` })}
      badge={more > 0 ? (
        // spacing-exempt: 1px 光学微调。Badge xs 高 20，比这一行的字（18）高 2：上下各收 1，叠起来的一行和结束行一样高（34）。
        <Box my={-1} shrink={0}><Badge
          size="xs"
          tone="muted"
          icon={<Icon name="copy" size={12} color="text-muted" />}
          label={m.stackMore(more)}
          {...(expanded ? {} : { testID: `channel-stack-${id}-count` })}
        /></Box>
      ) : null}
      trailing={replying
        ? <Text size="meta" weight="semibold" tone="accent" shrink={0} {...outcomeID(expanded)}>{m.replying}</Text>
        : <Text size="meta" tone="secondary" shrink={0} {...outcomeID(expanded)}>{outcome}</Text>}
    />
  );
  const list: GroupEntry[] = entries.map((entry) => {
    const card = byId.get(entry.cardId) ?? top;
    const line = channelPlainLine(card, entry.text, m);
    return {
      key: entry.key,
      time: clockWords(entry.at),
      content: (
        <Text size="secondary" tone="strong" numberOfLines={1}>
          {senders.size > 1 ? <Text size="label" weight="bold" tone="default">{`${entry.sender}  `}</Text> : null}
          {line}
        </Text>
      ),
    };
  });
  return (
    <Card w="100%" variant="flat" rounded="xl" overflow="hidden" bg="transparent" testID={`channel-stack-${id}`}>
      <AnchoredPanel
        open={open}
        onClose={() => setOpen(false)}
        label={m.stackPanel(top.sender.name, entries.length)}
        header={(
          <Pressable
            testID={`channel-stack-${id}-collapse`}
            aria-label={m.stackHide(top.sender.name)}
            aria-expanded
            feedback="none"
            onPress={() => setOpen(false)}
          >
            <Box px="card">{row(true)}</Box>
          </Pressable>
        )}
        body={<Box px="card" py="card-row"><GroupList entries={list} testID={`channel-stack-${id}-list`} /></Box>}
        testID={`channel-stack-${id}-anchor`}
      >
        <Pressable
          testID={`channel-stack-${id}-expand`}
          aria-label={m.stackShow(top.sender.name, entries.length)}
          aria-expanded={open}
          feedback="highlight"
          onPress={() => setOpen(true)}
        >
          {row(false)}
        </Pressable>
      </AnchoredPanel>
    </Card>
  );
}

// 会话里叠起来的一行：卡从 store 取（服务端改卡时整份重取），哪几条由时间线算好（entries）。
export function ChannelStackSlot({ cardIds, entries }: { cardIds: readonly number[]; entries: readonly ChannelStackEntry[] }) {
  const cards = useControlPlaneStore(useShallow((state) => cardIds
    .map((cardId) => state.channelCards.find((candidate) => candidate.id === cardId))
    .filter((card): card is ChannelCardDto => card !== undefined)));
  if (!cards.length) return null;
  return <Box w="100%"><ChannelStackRow cards={cards} entries={entries} /></Box>;
}
