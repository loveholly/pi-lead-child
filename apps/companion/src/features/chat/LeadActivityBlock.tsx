import {
  AnchoredPanel, Box, Column, GroupList, Icon, Pressable, RecordBlock, RecordLine, RecordTag, Row, Text, type IconName,
} from '@pi-lead-child/components';
import type { LeadActivityBasis, LeadActivityCard, LeadActivityCardAction } from '@pi-lead-child/protocol';
import { useMemo, useState } from 'react';

import { useCompanionRuntime, useControlPlaneStore, useWorkspaceStore } from '../../state/CompanionStateProvider';
import { useLeadName } from '../../state/hooks';
import { useOpenTicket } from './useOpenTicket';

// 「Lead 动态」（2026-10-15 方案 A，工单 06 扩展）：Lead 处理了、但没有对用户说的事，和只显示、不进 Lead 模型的事
// （digest 摘要、auto 自动处理、常设指令的修改），收成一块记录（模式「记录块」），按时间排在对话中间，不占对话回合。
// 一个对象一张卡：后来的事件原地更新它，Lead 后来记下的处置挂在同一行下面。
// Lead 同一次处置的几张卡（同一个处置、同一时间、同一个理由）合成一行，写件数（2026-10-24：一次处置了 4 件事，画成了 4 行一样的）。
// 收起时每行只有一行字：时间、标签（处置）、事件的摘要（2026-10-24 用户：收起时起码要有摘要，不用每次点开）。
// 展开后每行再写合进来的其他事、Lead 的理由和依据（常设指令的编号和版本）。点一行打开那张工单。
// 别处已处理的行是结束状态：标签写「已在别处处理」，文字变淡。
// Lead 对你说过的事不在这里，挂在说它的那一轮下面（TurnActivity，LeadConversation 的 foldToldActivity）。
// 卡上带操作时（LeadActivityCard.action，2026-10-29：Lead 改了常驻偏好、让一条事实失效），行尾是一个深色文字按钮（「撤销」），
// 和注脚的「撤销」一样（主题 11.6）。按钮的字和行的摘要一样高，状态变了这一行也不变高（P1.3）：
// 进行中写「正在撤销…」；做完以后、网关推来新卡之前写「已撤销」；失败时原因写在摘要旁边的同一行里（截断），
// 全文在展开的浮层里。撤销以后同一张卡原地更新，这个字段没了，按钮跟着消失。
const DISPOSITION_LABELS: Record<NonNullable<LeadActivityCard['lead']>['disposition'], string> = {
  deferred: '延后',
  no_action: '不处理',
  handled: '处理好了',
};

const KIND_LABELS: Record<Exclude<LeadActivityCard['kind'], 'lead'>, string> = {
  digest: '摘要',
  auto: '自动处理',
  standing_order: '指令修改',
};

// 硬性规则（写在代码里，不进常设指令表）的白话名字。leadName 是 Lead 的名字（useLeadName）。
function ruleLabels(leadName: string): Record<string, string> {
  return {
    standing_order_change_reported: '指令修改要告诉你',
    approval_reaches_user: '审批要送到你',
    external_never_interrupts: `外部来源不打断 ${leadName}`,
  };
}

export function leadActivityLabel(card: LeadActivityCard): string {
  if (card.state === 'resolved_elsewhere') return '已在别处处理';
  // 你允许以后才做的事（2026-10-28 改版稿第 2 组）：标签写是谁让做的，没做成时写没做成。
  if (card.ownerAction) return card.ownerAction.failed ? '你允许了，没做成' : '你允许了';
  if (card.kind === 'lead') return card.lead ? DISPOSITION_LABELS[card.lead.disposition] : '处理好了';
  return KIND_LABELS[card.kind];
}

function basisLabel(basis: LeadActivityBasis, rules: Record<string, string>): string {
  return basis.kind === 'order' ? `${basis.id} v${basis.version}` : rules[basis.name] ?? basis.name;
}

/** 「依据 inbox.no_wake v1 · inbox.merge_attention v1」。没有依据时是 null。leadName 是 Lead 的名字。 */
export function leadActivityBasisLine(card: Pick<LeadActivityCard, 'basis'>, leadName: string): string | null {
  if (!card.basis.length) return null;
  const rules = ruleLabels(leadName);
  return `依据 ${[...new Set(card.basis.map((basis) => basisLabel(basis, rules)))].join(' · ')}`;
}

function clock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

// 「18:10–18:14」；只有一件或者同一分钟时只写一个时间。
export function leadActivityRange(items: readonly Pick<LeadActivityCard, 'at'>[]): string {
  const first = clock(items[0]?.at ?? '');
  const last = clock(items.at(-1)?.at ?? '');
  return first === last ? first : `${first}–${last}`;
}

// 一行：一张卡，或者 Lead 同一次处置的几张卡。
export type LeadActivityRowModel = { key: string; cards: LeadActivityCard[] };

// 你允许的几件同类的事也合成一行（2026-10-28 改版稿第 2 组）：同一个对象的同一种操作，结果一样（都做成了，或者都没做成）。
// 没做成的那几件单独一行，不并进做成的行。
export function leadActivityRows(cards: readonly LeadActivityCard[]): LeadActivityRowModel[] {
  const rows: LeadActivityRowModel[] = [];
  const byDisposition = new Map<string, LeadActivityRowModel>();
  for (const card of cards) {
    const owner = card.ownerAction;
    // 带操作的卡自己占一行：按钮只对这一个对象（P4.1）。
    const disposition = card.state === 'resolved_elsewhere' || card.action ? null
      : owner ? `owner|${owner.action}|${owner.target}|${owner.failed}`
        : card.lead ? `${card.lead.disposition}|${card.lead.at}|${card.lead.reason}` : null;
    const same = disposition ? byDisposition.get(disposition) : undefined;
    if (same) {
      same.cards.push(card);
      continue;
    }
    const row = { key: card.key, cards: [card] };
    rows.push(row);
    if (disposition) byDisposition.set(disposition, row);
  }
  return rows;
}

// 一行的来源：卡属于哪个对象（entityKey 的第一段，例如 slack:dm:U1、ticket:77）。认不出的不写。
const SOURCES: Record<string, { label: string; icon?: IconName }> = {
  slack: { label: 'Slack', icon: 'hash' },
  github: { label: 'GitHub', icon: 'branch' },
  reminder: { label: '日程', icon: 'calendar' },
  calendar: { label: '日程', icon: 'calendar' },
  standing_order: { label: '指令' },
  connection: { label: '连接' },
  core_memory: { label: '常驻偏好' },
  memory_fact: { label: '记忆' },
};

export function leadActivitySource(card: Pick<LeadActivityCard, 'entityKey'>): { label: string; icon?: IconName } | null {
  return SOURCES[card.entityKey.split(':')[0] ?? ''] ?? null;
}

// 标题后面按来源计数：「Slack 5 · GitHub 2 · 日程 1」。认不出来源的不计。
export function leadActivitySourceCounts(items: readonly Pick<LeadActivityCard, 'entityKey'>[]): string | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    const source = leadActivitySource(item);
    if (source) counts.set(source.label, (counts.get(source.label) ?? 0) + 1);
  }
  return counts.size ? [...counts].map(([label, count]) => `${label} ${count}`).join(' · ') : null;
}

// 收起时最多显示这么多行（最新的几行）。
const COLLAPSED_ROWS = 3;

// 卡上一个操作的状态。signature 是操作本身：卡后来换了一个操作（Lead 又改了一次）时，旧的状态不算数。
type CardActionState = { signature: string; status: 'busy' | 'done' | 'failed'; message: string | null };

function actionSignature(action: LeadActivityCardAction): string {
  return `${action.target.type}:${action.target.id}/${action.action}`;
}

// 一行上的操作按钮要的东西。state 为 null 表示还没点过。
type RowAction = { action: LeadActivityCardAction; state: CardActionState | null; run: () => void };

// 一块记录里各张卡的操作状态。收起的行和浮层里的行是同一张卡，读同一份状态。
function useCardActions(perform: ((action: LeadActivityCardAction) => Promise<void>) | undefined) {
  const [states, setStates] = useState<Record<string, CardActionState>>({});
  return (card: LeadActivityCard): RowAction | null => {
    const action = card.action;
    if (!action || !perform || card.state === 'resolved_elsewhere') return null;
    const signature = actionSignature(action);
    const saved = states[card.key];
    const state = saved?.signature === signature ? saved : null;
    const set = (next: Omit<CardActionState, 'signature'>) => setStates((current) => ({ ...current, [card.key]: { signature, ...next } }));
    return {
      action,
      state,
      run: () => {
        if (state?.status === 'busy') return;
        set({ status: 'busy', message: null });
        perform(action).then(
          () => set({ status: 'done', message: null }),
          (reason: unknown) => set({ status: 'failed', message: reason instanceof Error ? reason.message : String(reason) }),
        );
      },
    };
  };
}

// 失败时的那句话：按钮的字加 daemon 写的原因，原因原样显示。
function actionFailure(row: RowAction): string | null {
  return row.state?.status === 'failed' ? `${row.action.label}没有完成：${row.state.message || '请再试一次'}` : null;
}

// 行尾的深色文字按钮，和摘要的字一样高（不用 Button：它比这一行高，按钮消失时这一行会变矮）。
function CardActionButton({ row, cardKey, covered }: { row: RowAction; cardKey: string; covered: boolean }) {
  const { action, state } = row;
  const testID = covered ? undefined : `lead-activity-action-${cardKey}`;
  if (state?.status === 'busy') {
    return <Text testID={testID} size="meta" weight="semibold" tone="secondary" shrink={0}>{`正在${action.label}…`}</Text>;
  }
  if (state?.status === 'done') {
    return <Text testID={testID} size="meta" weight="semibold" tone="success-dark" shrink={0}>{`已${action.label}`}</Text>;
  }
  return (
    <Pressable
      testID={testID}
      shrink={0}
      feedback="opacity"
      aria-label={action.label}
      // 这一行本身能点（打开工单）时，点按钮不连带打开工单。
      onPress={(event) => {
        event?.stopPropagation?.();
        row.run();
      }}
    >
      <Text size="meta" weight="semibold" tone="default">{action.label}</Text>
    </Pressable>
  );
}

// 2026-10-27 按画布「后台处理记录」改成模式「记录块」（主题 11.8）：左边一条细线，顶上安静版的 Fairy 标记，没有框。
// 每行：等宽时间、标签（来源 · 处置；「延后」浅琥珀底；别处已处理是细边框加勾、整行变淡）、摘要、行尾的件数。
// 展开以后每行是一块浅灰底：下面用引号竖线写 Lead 的理由，依据写成等宽的小标签；能打开工单的行尾写工单号。
function LeadActivityRow({ row, leadName, detailed, onOpenTicket, covered = false, action = null }: {
  row: LeadActivityRowModel;
  leadName: string;
  // 卡上的操作（只有一张卡的行才有）。
  action?: RowAction | null;
  // 浮层打开、盖住了原位置的这一行：它不再带 testID，测试和读屏读的是浮层里那一行。
  covered?: boolean;
  // false：只有一行字（收起时）。true：再写涉及的事、Lead 的补充和依据。
  detailed: boolean;
  onOpenTicket: (ticketId: number) => void;
}) {
  const card = row.cards[0]!;
  const ended = card.state === 'resolved_elsewhere';
  const owner = card.ownerAction;
  // 这一行说的是事件本身（系统写的摘要），Lead 的理由挂在下面（2026-10-24：以前 Lead 处置的那一行写理由，
  // 收起时只看到「进展正常」「等最终结论一起说」，看不出是哪件事）。标签已经写了处置，Lead 处置的行下面只写理由。
  // 你允许的事写主人操作那句话（对你说的），不写交给 Lead 的说明；合了几件时写对象，件数在行尾，每件在展开后的明细里。
  const text = owner ? (row.cards.length > 1 ? owner.target || owner.summary : owner.summary) : card.summary;
  const note = card.lead?.reason
    ? `${leadName}：${card.kind === 'lead' ? '' : `${DISPOSITION_LABELS[card.lead.disposition]} · `}${card.lead.reason}`
    : null;
  // 合进这一行的其他事的摘要。你允许的事按件列出（GroupList）。
  const things = owner ? [] : [...new Set(row.cards.map((item) => item.summary))].filter((summary) => summary !== text);
  const ownerEntries = owner && row.cards.length > 1
    ? row.cards.map((item) => ({ key: item.key, time: clock(item.at), content: item.ownerAction?.summary ?? item.summary }))
    : [];
  const rules = ruleLabels(leadName);
  const basis = [...new Set(row.cards.flatMap((item) => item.basis).map((item) => basisLabel(item, rules)))];
  const tickets = new Set(row.cards.map((item) => item.ticketId));
  const ticketId = tickets.size === 1 ? card.ticketId : null;
  const count = row.cards.length > 1 ? `${row.cards.length} 件` : card.count > 1 ? `${card.count} 条` : null;
  const source = leadActivitySource(card);
  const act = row.cards.length === 1 && !ended ? action : null;
  const failure = act ? actionFailure(act) : null;
  // 收起时失败的原因和摘要分这一行的宽度，各自截断；展开后原因整句写在下面。
  const inlineFailure = failure && !detailed ? failure : null;
  const hasDetail = detailed && (things.length > 0 || ownerEntries.length > 0 || note !== null || basis.length > 0 || failure !== null);
  return (
    <RecordLine
      {...(covered ? {} : { testID: `lead-activity-${card.key}` })}
      time={owner && row.cards.length > 1 ? leadActivityRange(row.cards) : clock(card.at)}
      tag={(
        <RecordTag
          source={ended ? null : source?.label}
          {...(source?.icon && !ended ? { icon: source.icon } : {})}
          label={leadActivityLabel(card)}
          labelTestID="lead-activity-label"
          tone={ended ? 'done' : owner?.failed || card.lead?.disposition === 'deferred' ? 'warning' : 'neutral'}
        />
      )}
      text={text}
      ended={ended}
      lines={detailed ? 2 : 1}
      inset={detailed}
      {...(ticketId ? { onPress: () => onOpenTicket(ticketId) } : {})}
      trailing={(
        <Row items="center" gap="icon-label" {...(inlineFailure ? { flex: 1, minW: 0 } : { shrink: 0 })}>
          {inlineFailure ? (
            <Text {...(covered ? {} : { testID: 'lead-activity-action-error' })} flex={1} minW={0} size="meta" tone="danger-dark" numberOfLines={1}>
              {inlineFailure}
            </Text>
          ) : null}
          {count ? <Text size="meta" tone="muted">{count}</Text> : null}
          {act ? <CardActionButton row={act} cardKey={card.key} covered={covered} /> : null}
          {detailed && ticketId ? (
            <Row items="center" gap="text-stack">
              <Text size="meta" weight="semibold" tone="strong">{`#${ticketId}`}</Text>
              <Icon name="chevron-right" size={10} color="text" weight="semibold" />
            </Row>
          ) : null}
        </Row>
      )}
      {...(hasDetail ? {
        detail: (
          <Column gap="text-stack">
            {failure ? <Text testID="lead-activity-action-error" size="note" tone="danger-dark">{failure}</Text> : null}
            {ownerEntries.length ? <GroupList testID="lead-activity-owner-entries" entries={ownerEntries} /> : null}
            {things.map((summary) => (
              <Text key={summary} testID="lead-activity-thing" size="secondary" tone="muted" numberOfLines={1}>{summary}</Text>
            ))}
            {note ? (
              // 引用缩进：左边一条竖线（主题 11.8 状态 3）。
              <Box borderLeftWidth={2} borderLeftColor="border-strong" pl="inline-item">
                <Text testID="lead-activity-note" size="secondary" tone="strong" numberOfLines={2}>{note}</Text>
              </Box>
            ) : null}
            {basis.length ? (
              <Row testID="lead-activity-basis" flexWrap="wrap" gap="chips">
                {basis.map((item) => (
                  <Box key={item} testID="lead-activity-basis-item" px="pill-x" rounded="xs" borderWidth={1} borderColor="border" bg="surface">
                    <Text size="eyebrow" mono tone="secondary">{item}</Text>
                  </Box>
                ))}
              </Row>
            ) : null}
          </Column>
        ),
      } : {})}
    />
  );
}

export function LeadActivityBlockView({
  items,
  leadName,
  expanded: controlled,
  defaultExpanded = false,
  onExpandedChange,
  onOpenTicket,
  onCardAction,
}: {
  items: readonly LeadActivityCard[];
  // Lead 的名字（useLeadName）：块的标题「<名字> 在后台处理了 N 件事」和每一行下面 Lead 的处置用它。
  leadName: string;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onOpenTicket: (ticketId: number) => void;
  // 卡上的按钮（LeadActivityCard.action）。不给时不画按钮。失败时抛出，原因写在那一行上。
  onCardAction?: (action: LeadActivityCardAction) => Promise<void>;
}) {
  const [own, setOwn] = useState(defaultExpanded);
  const actionFor = useCardActions(onCardAction);
  const expanded = controlled ?? own;
  const setExpanded = (next: boolean) => {
    if (controlled === undefined) setOwn(next);
    if (next !== expanded) onExpandedChange?.(next);
  };
  const rows = useMemo(() => leadActivityRows(items), [items]);
  if (!items.length) return null;
  const shown = rows.slice(-COLLAPSED_ROWS);
  const hidden = rows.length - shown.length;
  const title = `${leadName} 在后台处理了 ${items.length} 件事 · ${leadActivityRange(items)}`;
  const meta = leadActivitySourceCounts(items);
  // 展开不在会话里原地撑开（会话列表不跳）：从这一块原来的位置撑开成浮层，列出每一行的理由和依据。
  return (
    <AnchoredPanel
      testID="lead-activity-anchor"
      open={expanded}
      onClose={() => setExpanded(false)}
      label={title}
      header={<Box px="card" py="card-row"><RecordBlock testID="lead-activity-block" title={title} meta={meta} toggle={{ expanded: true, onPress: () => setExpanded(false) }} /></Box>}
      body={(
        <Column testID="lead-activity-panel" px="card" py="card-row" gap="list-row">
          {rows.map((row) => (
            <LeadActivityRow key={row.key} row={row} leadName={leadName} detailed onOpenTicket={onOpenTicket} action={actionFor(row.cards[0]!)} />
          ))}
        </Column>
      )}
    >
      <RecordBlock {...(expanded ? {} : { testID: 'lead-activity-block' })} title={title} meta={meta} toggle={{ expanded: false, onPress: () => setExpanded(true) }}>
        {hidden > 0 ? (
          <Pressable onPress={() => setExpanded(true)} feedback="none" self="flex-start">
            <Text size="meta" tone="muted">{`更早的 ${hidden} 行`}</Text>
          </Pressable>
        ) : null}
        {shown.map((row) => (
          <LeadActivityRow key={row.key} row={row} leadName={leadName} detailed={false} covered={expanded} onOpenTicket={onOpenTicket} action={actionFor(row.cards[0]!)} />
        ))}
      </RecordBlock>
    </AnchoredPanel>
  );
}

// 挂在一轮回复下面的「Lead 动态」（2026-10-24）：这一轮里、和这一轮之后同一件事上 Lead 处理掉的事。
// 回复已经说了这件事，所以只留一行灰字「顺手处理了 N 件事」（前面两个小圆点，主题 11.8 状态 4），点开在浮层里列出来。
export function TurnActivityView({ items, leadName, expanded, onToggle, onOpenTicket, onCardAction }: {
  items: readonly LeadActivityCard[];
  leadName: string;
  expanded: boolean;
  onToggle: () => void;
  onOpenTicket: (ticketId: number) => void;
  onCardAction?: (action: LeadActivityCardAction) => Promise<void>;
}) {
  const rows = useMemo(() => leadActivityRows(items), [items]);
  const actionFor = useCardActions(onCardAction);
  if (!items.length) return null;
  const line = (open: boolean) => (
    <Pressable onPress={onToggle} feedback="none" self="flex-start" aria-label={open ? '收起处理的事' : '展开处理的事'}>
      <Row items="center" gap="icon-label">
        <Row aria-hidden>
          {/* 两个叠在一起的小圆点（组件规格）。 */}
          <Box w={6} h={6} rounded="full" bg="text-muted" />
          <Box
            w={6} h={6} rounded="full" bg="border-strong"
            ml={-2} // spacing-exempt: 两个圆点叠在一起
          />
        </Row>
        <Text size="meta" weight="semibold" tone="secondary">{`顺手处理了 ${items.length} 件事`}</Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={11} color="text-secondary" weight="semibold" />
      </Row>
    </Pressable>
  );
  return (
    <Box testID="turn-activity" w="100%">
      <AnchoredPanel
        open={expanded}
        onClose={onToggle}
        label={`${leadName} 顺手处理了 ${items.length} 件事`}
        header={<Box px="card" py="card-row">{line(true)}</Box>}
        body={(
          <Column px="card" py="card-row" gap="list-row">
            {rows.map((row) => (
              <LeadActivityRow key={row.key} row={row} leadName={leadName} detailed onOpenTicket={onOpenTicket} action={actionFor(row.cards[0]!)} />
            ))}
          </Column>
        )}
      >
        {line(false)}
      </AnchoredPanel>
    </Box>
  );
}

export function TurnActivity({ ids }: { ids: readonly string[] }) {
  const cards = useControlPlaneStore((state) => state.leadActivity.cards);
  const items = useMemo(() => ids.flatMap((id) => cards[id] ? [cards[id]] : []), [cards, ids]);
  const key = `turn-activity:${ids[0] ?? 'none'}`;
  const expanded = useWorkspaceStore((state) => Boolean(state.expandedMessagePartIds[key]));
  const toggle = useWorkspaceStore((state) => state.toggleMessagePart);
  const openTicket = useOpenTicket();
  const leadName = useLeadName();
  const runtime = useCompanionRuntime();
  return (
    <TurnActivityView items={items} leadName={leadName} expanded={expanded} onToggle={() => toggle(key)} onOpenTicket={openTicket}
      onCardAction={(action) => runtime.leadActivityCardAction(action)} />
  );
}

// 会话时间线里的一块：按卡片的 key 从 store 取；卡片原地更新时这一块跟着变。展开状态记在 workspace store，重新渲染还在。
export function LeadActivityBlock({ ids, defaultExpanded }: { ids: readonly string[]; defaultExpanded: boolean }) {
  const cards = useControlPlaneStore((state) => state.leadActivity.cards);
  const items = useMemo(() => ids.flatMap((id) => cards[id] ? [cards[id]] : []), [cards, ids]);
  const key = `lead-activity:${ids[0] ?? 'none'}`;
  // 记下的是「和默认值相反」：默认展开的块记下的是收起，反之亦然。
  const flipped = useWorkspaceStore((state) => Boolean(state.expandedMessagePartIds[key]));
  const toggle = useWorkspaceStore((state) => state.toggleMessagePart);
  const openTicket = useOpenTicket();
  const leadName = useLeadName();
  const runtime = useCompanionRuntime();
  return (
    <LeadActivityBlockView
      items={items}
      leadName={leadName}
      expanded={flipped ? !defaultExpanded : defaultExpanded}
      onExpandedChange={() => toggle(key)}
      onOpenTicket={openTicket}
      onCardAction={(action) => runtime.leadActivityCardAction(action)}
    />
  );
}
