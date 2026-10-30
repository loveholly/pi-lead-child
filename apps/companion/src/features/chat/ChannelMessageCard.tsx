import {
  Box, Button, Card, Column, FairyMark, Icon, IconButton, Link, Pressable, ProgressBar, Row, Text, TextField,
  type ColorToken, type SegmentItem, type TextTone,
} from '@pi-lead-child/components';
import {
  CHANNEL_CARD_TEXT_MAX, CHANNEL_INTENT_LABELS, classifyLeadModelError, leadModelFailureShortLabel, type ChannelCardAction, type ChannelCardDto,
  type LeadStatus,
} from '@pi-lead-child/protocol';
import { Fragment, useEffect, useState, type ReactNode } from 'react';

import { DisclosureView } from '../genui/SurfaceControls';

import { useCompanionRuntime, useControlPlaneStore } from '../../state/CompanionStateProvider';
import {
  CHANNEL_EDITED_DISCLOSURE, channelCardView, clockWords, type ChannelCardTone, type ChannelCheckMark,
  type ChannelLookupView, type ChannelReplyTrackView,
} from './channelCard';
import { MarkdownMessage } from './MarkdownMessage';
import { slackPlainText, slackToMarkdown } from './slackMarkdown';
import { useOpenTicket } from './useOpenTicket';

// 会话里一条外部来源的消息（工单 11，spec D10）：发信人、原文摘录、起草的回复，和「用草稿回复」「我自己回」「稍后」「不回」。
// 自动回复以后在撤回窗口里有「撤回」。一个对话一张卡，状态原地更新。摘要投递的卡显示成一行，点开才有按钮。
//
// 通道判断过的卡按用户认可的样例排版（Slack 代查与按信心代回 spec D9 工单 05，落地计划 D3）：
//   处理  代码 review · 要干活 · Lead 派了工单
//         Lead：……（Lead 推送或者告诉你时写的话）
//   干活  ✓ 工单 #482 · 完成于 14:32 · 2 处出处已核实      （工单号可以点开）
//         在 acme/orders#12 提交了 COMMENT review          （做了的动作，有链接的可以点开）
//   代回  问你 · 抽查 · 信心 0.71（自动门槛 0.85）
//         依据核实 ✓  做到了所求 ✓  有依据 △  理解了请求 ✓ 0.80  这一段历史 15/20
//   草稿  ……（旁边一行小字说明直接回复时加什么前缀）
//   [直接回复] [改一下再发] [我自己回] [不用回]
// 答案和出处、review 的评论、读过的文件可以展开。「改一下再发」打开输入框，预填草稿，发出时是 send_edited。
// 结束、也没有按钮的卡收成一行（照 ReminderFireCard），点开看全部。

const TONE_TEXT: Record<ChannelCardTone, TextTone> = {
  accent: 'accent', neutral: 'default', success: 'success-dark', warning: 'warning-dark', muted: 'secondary',
};
const MARK_TEXT: Record<ChannelCheckMark, TextTone> = { '✓': 'success-dark', '△': 'warning-dark', '✗': 'danger-dark' };

// 一条轨道：左边是「处理」「干活」「代回」这样的标签，右边是内容。
function Track({ label, children, testID }: { label: string; children: ReactNode; testID?: string }) {
  return (
    <Row items="flex-start" gap="side-item" testID={testID}>
      <Text w={30} shrink={0} size="label" weight="semibold" tone="secondary">{label}</Text>
      <Column flex={1} minW={0} gap="text-stack">{children}</Column>
    </Row>
  );
}

function Toggle({ label, open, onPress, testID }: { label: string; open: boolean; onPress: () => void; testID: string }) {
  return (
    <Button
      label={label}
      onPress={onPress}
      variant="link"
      size="xs"
      icon={open ? 'chevron-up' : 'chevron-down'}
      iconPosition="end"
      testID={testID}
      accessibilityLabel={`${label}，${open ? '收起' : '展开'}`}
    />
  );
}

function SmallLines({ lines, tone = 'secondary', prefix = '', testID }: {
  lines: readonly string[]; tone?: TextTone; prefix?: string; testID?: string;
}) {
  if (!lines.length) return null;
  return (
    <Column gap="text-stack" testID={testID}>
      {lines.map((line, index) => <Text key={`${index}:${line}`} size="note" tone={tone}>{`${prefix}${line}`}</Text>)}
    </Column>
  );
}

// 为什么可以这样回（画布状态 4 的右栏）：每项检查一行，过了是绿勾，不够强是琥珀叹号，没过是红叉，后面写这一项的说明。
// 下面一行是决定、信心和门槛，再下面是否决项和原因。
function ReplyTrack({ id, reply }: { id: number; reply: ChannelReplyTrackView }) {
  return (
    <Column gap="text-stack" testID={`channel-card-${id}-reply-track`}>
      {reply.checks.length ? (
        <Column gap="text-stack" testID={`channel-card-${id}-checks`}>
          {reply.checks.map((check) => (
            <Row key={check.label} items="center" gap="icon-label">
              <Text size="label" weight="bold" tone={MARK_TEXT[check.mark]} w={12}>{check.mark === '✓' ? '✓' : check.mark === '△' ? '!' : '✗'}</Text>
              <Text size="note" weight="semibold">{check.label}</Text>
              <Text flex={1} minW={0} size="note" tone="secondary" numberOfLines={2}>{[check.value, check.detail].filter((part, index, all) => part && all.indexOf(part) === index).join(' · ')}</Text>
            </Row>
          ))}
          {reply.history ? <Text size="note" tone="secondary">{reply.history}</Text> : null}
        </Column>
      ) : null}
      <Text size="meta" weight="semibold" tone={TONE_TEXT[reply.tone]}>{reply.text}</Text>
      <SmallLines lines={reply.vetoes} tone="warning-dark" prefix="否决：" testID={`channel-card-${id}-vetoes`} />
      <SmallLines lines={reply.reasons} testID={`channel-card-${id}-reply-reasons`} />
    </Column>
  );
}

// 卡上的工单（以前叫代查）：干活轨和做了的动作，代回轨（reply），过时提示、谁能看到回复，
// 和可以展开的答案、出处、评论、读过的文件。
function LookupSection({ id, lookup, reply, onOpenTicket }: {
  id: number;
  lookup: ChannelLookupView;
  reply: ReactNode;
  onOpenTicket?: (ticketId: number) => void;
}) {
  const [open, setOpen] = useState<'details' | 'comments' | 'reads' | null>(null);
  const toggle = (part: 'details' | 'comments' | 'reads') => setOpen((current) => (current === part ? null : part));
  const { track } = lookup;
  const trackTone = TONE_TEXT[track.tone];
  const ticketId = track.ticketId;
  const hasDetails = Boolean(lookup.answer) || lookup.sources.length > 0 || lookup.caveats.length > 0
    || (!lookup.checkedVisible && lookup.checked.length > 0);
  // 工单号前面：没有状态词时（查到）只隔一个空格，「✓ 工单 #482」；别的用「·」隔开。
  const segments: ReactNode[] = [
    // 工单号是一段可以点的字，和这一行的字一样高（按钮会把这一行撑高）。
    ...(ticketId ? [onOpenTicket
      ? (
        <Pressable
          key="ticket"
          onPress={() => onOpenTicket(ticketId)}
          aria-label={`打开工单 #${ticketId}`}
          testID={`channel-card-${id}-ticket`}
        >
          <Text size="label" weight="semibold" tone="accent">{`工单 #${ticketId}`}</Text>
        </Pressable>
      )
      : <Text key="ticket" size="label">{`工单 #${ticketId}`}</Text>] : []),
    ...track.details.map((detail) => <Text key={detail} size="meta" tone="secondary">{detail}</Text>),
  ];
  return (
    <Column gap="card-row" testID={`channel-card-${id}-lookup`}>
      <Track label="干活" testID={`channel-card-${id}-lookup-track`}>
        <Row items="center" gap="inline-item" flexWrap="wrap" aria-label={track.text}>
          <Text size="label" weight="semibold" tone={trackTone}>{[track.mark, track.status].filter(Boolean).join(' ')}</Text>
          {segments.map((segment, index) => (
            <Fragment key={index}>
              {/* spacing-exempt: 折叠摘要行的字号行高 */}
              {index > 0 || track.status ? <Text size="12.5" leading={20} tone="muted">·</Text> : null}
              {segment}
            </Fragment>
          ))}
        </Row>
        <SmallLines lines={track.reasons} testID={`channel-card-${id}-lookup-reasons`} />
        {lookup.actions.length ? (
          <Column gap="list-row" testID={`channel-card-${id}-actions`}>
            {lookup.actions.map((action, index) => (action.url
              ? <Link key={`${index}:${action.text}`} href={action.url} size="label">{action.text}</Link>
              : <Text key={`${index}:${action.text}`} size="label">{action.text}</Text>))}
          </Column>
        ) : null}
        {lookup.reviewSummary ? <Text size="body">{lookup.reviewSummary}</Text> : null}
        {lookup.checkedVisible && lookup.checked.length ? (
          <SmallLines lines={lookup.checked} prefix="查过：" testID={`channel-card-${id}-checked`} />
        ) : null}
      </Track>
      {reply}
      {lookup.stale ? (
        <Row items="center" gap="icon-label" testID={`channel-card-${id}-stale`}>
          <Icon name="warning" size={12} color="warning" />
          <Text flex={1} minW={0} size="secondary" tone="warning-dark">{lookup.stale}</Text>
        </Row>
      ) : null}
      <Text size="note" tone={lookup.audience.external ? 'warning-dark' : 'secondary'} testID={`channel-card-${id}-audience`}>
        {lookup.audience.text}
      </Text>
      {hasDetails || lookup.comments || lookup.reads ? (
        <Row gap="inline-item" flexWrap="wrap">
          {hasDetails ? (
            <Toggle
              label={lookup.sources.length ? `答案和出处（${lookup.sources.length}）` : '答案'}
              open={open === 'details'}
              onPress={() => toggle('details')}
              testID={`channel-card-${id}-details-toggle`}
            />
          ) : null}
          {lookup.comments ? (
            <Toggle
              label={`${lookup.comments.count} 条评论`}
              open={open === 'comments'}
              onPress={() => toggle('comments')}
              testID={`channel-card-${id}-comments-toggle`}
            />
          ) : null}
          {lookup.reads ? (
            <Toggle
              label={`读过 ${lookup.reads.count} 处`}
              open={open === 'reads'}
              onPress={() => toggle('reads')}
              testID={`channel-card-${id}-reads-toggle`}
            />
          ) : null}
        </Row>
      ) : null}
      {open === 'details' ? (
        <Column gap="card-row" bg="surface-subtle" rounded="lg" px="inset-x" py="inset-y" testID={`channel-card-${id}-details`}>
          {lookup.answer ? <Text size="body">{lookup.answer}</Text> : null}
          {lookup.sources.map((source, index) => (
            <Column key={`${index}:${source.where}`} gap="text-stack">
              <Text size="note" tone={source.verified ? 'secondary' : 'danger-dark'}>
                {`${source.verified ? '✓' : '✗ 没核实'} ${source.where}`}
              </Text>
              <Text size="code" mono tone="muted" numberOfLines={4}>{source.quote}</Text>
            </Column>
          ))}
          {!lookup.checkedVisible ? <SmallLines lines={lookup.checked} prefix="查过：" /> : null}
          <SmallLines lines={lookup.caveats} prefix="不确定：" />
        </Column>
      ) : null}
      {open === 'comments' && lookup.comments ? (
        <Column gap="card-row" bg="surface-subtle" rounded="lg" px="inset-x" py="inset-y" testID={`channel-card-${id}-comments`}>
          {lookup.comments.items.map((comment, index) => (
            <Column key={`${index}:${comment.where}`} gap="text-stack">
              <Text size="code" mono tone="secondary">{comment.where}</Text>
              <Text size="body">{comment.body}</Text>
            </Column>
          ))}
        </Column>
      ) : null}
      {open === 'reads' && lookup.reads ? (
        <Column gap="text-stack" bg="surface-subtle" rounded="lg" px="inset-x" py="inset-y" testID={`channel-card-${id}-reads`}>
          {lookup.reads.items.map((item, index) => (
            <Text key={`${index}:${item}`} size="code" mono tone="secondary">{item}</Text>
          ))}
          {lookup.reads.partial ? (
            <Text size="note" tone="muted">
              {lookup.reads.items.length ? `只列出其中 ${lookup.reads.items.length} 处` : '没有逐条的明细'}
            </Text>
          ) : null}
        </Column>
      ) : null}
    </Column>
  );
}

// 2026-10-27 按画布「Slack 消息卡」重画（对象组件 ChannelCard → 模式「外来消息」，主题 default.md 11.2）：
//   列表里（A）：头部一行（来源图标、人名、对话、时间，右边状态点和状态词）；对方的话一行，放在别人说话的气泡里，多条时前面「N 条」；
//     Fairy 的一行（标记 + 600 的结论 + 草稿或进度，进行中时加一根细进度条）；分隔线下面是操作栏，最右边是信心胶囊（五格 + 信心）。
//   点卡片空白处（B）：原位置撑开成浮层，对方连发的几条叠在同一个名字下，草稿全文在白底细边框的框里，信心五格写明差在哪里，
//     「详情」里左边是 Fairy 做了什么、右边是为什么可以这样回；操作栏右边多出「稍后」「不回」。
//   改一下再发：草稿框原地变成输入框。已发出：框里是发出的原文，加「已发出」。撤回窗口里只剩「撤回 还剩 4:32」。
//   结束、也没有按钮的卡收成一行（模式「结束行」），点开看全部。
// 不再用卡片左边的色条（主题 C-18）。数据和按钮的判断还是 channelCard.ts。
export function ChannelMessageCard({ card, onAction, onOpenTicket, now, lead }: {
  card: ChannelCardDto;
  // text：「改一下再发」时用户写的文字（send_edited）。别的动作不带。
  onAction: (action: ChannelCardAction, text?: string) => Promise<void>;
  // 点工单号时打开代查工单。没有时工单号只是文字。
  onOpenTicket?: (ticketId: number) => void;
  now?: Date;
  // Lead 的健康状态（概览里的 lead，顶栏的状态点读同一份）。Lead 不能工作时，排着的卡写它卡住了。
  lead?: LeadStatus;
}) {
  const view = channelCardView(card, now);
  const [busy, setBusy] = useState<ChannelCardAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // 「改一下再发」的输入框：null 是没打开。
  const [edit, setEdit] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  // 撤回窗口里每秒走一次，按钮上的「还剩 4:32」跟着变。
  const [, setTick] = useState(0);
  const counting = card.actions.includes('undo_auto_reply') && card.revokeUntil !== null && Date.parse(card.revokeUntil) > Date.now();
  useEffect(() => {
    if (!counting || now) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [counting, now]);
  const act = (action: ChannelCardAction, text?: string) => {
    setBusy(action);
    setError(null);
    (text === undefined ? onAction(action) : onAction(action, text))
      .then(() => {
        if (action === 'send_edited') setEdit(null);
        setOpen(false);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null));
  };
  const press = (action: ChannelCardAction) => {
    if (action === 'send_edited') {
      setError(null);
      setEdit(card.draft?.text ?? '');
      setOpen(true);
      return;
    }
    act(action);
  };
  const status = statusOf(card, view);
  const fairy = fairyLine(card, view, lead);
  const score = scoreOf(card, view);
  const header = (
    <Row items="center" gap="inline-item" minW={0}>
      {card.objectKey.includes(':C') || card.objectKey.includes('#')
        ? <Text size="label" weight="bold" tone="secondary">#</Text>
        : <Icon name="chat" size={13} color="text-secondary" />}
      <Text size="label" weight="bold" numberOfLines={1} shrink={0}>{card.sender.name}</Text>
      <Text flex={1} minW={0} size="meta" tone="secondary" numberOfLines={1}>{metaWords(card)}</Text>
      <Row items="center" gap="icon-label" shrink={0} testID={`channel-card-${card.id}-state`}>
        <Dot tone={status.tone} />
        <Text size="meta" weight="semibold" tone={DOT_TEXT[status.tone]}>{status.label}</Text>
      </Row>
    </Row>
  );
  const mainButtons = view.buttons.filter((button) => !SIDE_ACTIONS.has(button.action));
  const sideButtons = view.buttons.filter((button) => SIDE_ACTIONS.has(button.action));
  const bar = (expanded: boolean) => (mainButtons.length || score || (expanded && sideButtons.length) ? (
    <Row items="center" gap="actions" pt="card-row" borderTopWidth={1} borderTopColor="border-soft" flexWrap="wrap">
      {mainButtons.map((button) => (
        <CardButton
          key={button.action}
          card={card}
          action={button.action}
          label={labelOf(button.action, button.label, card, now)}
          primary={button.primary}
          busy={busy}
          onPress={press}
          suffix={expanded ? '-p' : ''}
        />
      ))}
      <Box flex={1} />
      {expanded ? sideButtons.map((button) => (
        <CardButton key={button.action} card={card} action={button.action} label={button.label} primary={false} busy={busy} onPress={press} suffix="-p" />
      )) : null}
      {score && !expanded ? <ConfidencePill score={score} testID={`channel-card-${card.id}-confidence`} /> : null}
    </Row>
  ) : null);

  const summary = view.folded ? (
    // 结束行（P9.4）：状态图标、人名、对方的话、结果和时间、展开箭头。
    <Row items="center" gap="inline-item" px="card" py="card-row" minW={0}>
      <Icon name={status.tone === 'success' ? 'check' : 'chat'} size={13} color={status.tone === 'success' ? 'success' : 'text-muted'} />
      <Text size="label" weight="bold" shrink={0}>{card.sender.name}</Text>
      <Text testID={`channel-card-${card.id}-line`} flex={1} minW={0} size="secondary" tone="strong" numberOfLines={1}>{plainLine(card, card.recent?.at(-1)?.text ?? card.excerpt)}</Text>
      <Text size="meta" tone="secondary" shrink={0} testID={`channel-card-${card.id}-outcome`}>{view.folded.outcome}</Text>
      <Icon name="chevron-down" size={12} color="text-muted" />
    </Row>
  ) : (
    <Column p="card" gap="card-row">
      {header}
      <LatestMessage card={card} />
      <FairyRow line={fairy} oneLine testID={`channel-card-${card.id}-fairy`} />
      {/* 对方要求改规则（spec D10 的 Jev 标记）：收起时也写，「没有照做」不该点开才看到。 */}
      {view.handling?.ruleChange ? (
        <Text size="note" tone="warning-dark" numberOfLines={1} testID={`channel-card-${card.id}-rule-change`}>{view.handling.ruleChange}</Text>
      ) : null}
      {/* 摘要投递的卡不打扰：收起时没有按钮，点开才有（工单 11）。 */}
      {view.compact ? null : bar(false)}
    </Column>
  );

  // 浮层里草稿全文在下面的框里：这一行不再重复草稿，改写做了的事（工单、读了什么、留了什么）。
  const panelFairy: FairyLineView = edit !== null
    ? { lead: '你在改 Fairy 的草稿', rest: CHANNEL_EDITED_DISCLOSURE, progress: null }
    : card.draft ? { ...fairy, rest: view.lookup?.track.details.join(' · ') || null } : fairy;
  // 结束的卡：Fairy 那一行已经写了结果，不再写一句同样意思的结束说明（2026-10-28 用户报的重复尾巴）。
  const panelNote = view.note && !view.closed && panelFairy.rest !== view.note ? view.note : null;
  const panel = (
    <Column p="card" gap="card-row" testID={`channel-card-${card.id}-panel`}>
      <Row items="center" gap="inline-item">
        <Box flex={1} minW={0}>{header}</Box>
        <IconButton icon="chevron-up" label="收起" size="xs" variant="ghost" onPress={() => setOpen(false)} testID={`channel-card-${card.id}-collapse`} />
      </Row>
      <MessageStack card={card} />
      <Row items="center" gap="inline-item">
        <Box flex={1} minW={0}>
          <FairyRow line={panelFairy} />
        </Box>
        {view.lookup || view.reply ? (
          <Button
            label={details ? '收起' : '详情'}
            onPress={() => setDetails((value) => !value)}
            variant="link"
            size="xs"
            icon={details ? 'chevron-up' : 'chevron-down'}
            iconPosition="end"
            testID={`channel-card-${card.id}-more`}
          />
        ) : null}
      </Row>
      {/* 对方要求改规则时（spec D10 的 Jev 标记，工单 08）：用「等你」的颜色写明没有照做，要不要改由你定（C-11）。 */}
      {view.handling?.ruleChange ? (
        <Text size="note" tone="warning-dark" testID={`channel-card-${card.id}-rule-change-p`}>{view.handling.ruleChange}</Text>
      ) : null}
      {view.handling?.note ? <Text size="note" tone="accent" testID={`channel-card-${card.id}-lead-note`}>{view.handling.note}</Text> : null}
      {edit !== null ? (
        <Column gap="card-row" testID={`channel-card-${card.id}-editor`}>
          <TextField
            value={edit}
            onChangeText={setEdit}
            multiline
            height={104}
            maxLength={CHANNEL_CARD_TEXT_MAX}
            disabled={busy !== null}
            autoFocus
            emphasis="accent"
            placeholder="写给对方的回复"
            accessibilityLabel="改一下再发的文字"
            testID={`channel-card-${card.id}-edit-input`}
          />
        </Column>
      ) : view.draft ? (
        <Column borderWidth={1} borderColor="border" rounded="lg" px="inset-x" py="inset-y" gap="text-stack" testID={`channel-card-${card.id}-draft`}>
          <Text size="message-body">{view.draft}</Text>
          {view.disclosure ? <Text size="note" tone="muted" testID={`channel-card-${card.id}-disclosure`}>{view.disclosure}</Text> : null}
        </Column>
      ) : card.sentText ? (
        <Row borderWidth={1} borderColor="border" rounded="lg" px="inset-x" py="inset-y" gap="side-item" items="flex-start" testID={`channel-card-${card.id}-sent`}>
          <Text flex={1} minW={0} size="message-body">{card.sentText}</Text>
          <Row items="center" gap="text-stack" shrink={0}>
            <Icon name="check" size={11} color="success" weight="bold" />
            <Text size="meta" weight="semibold" tone="success-dark">已发出</Text>
          </Row>
        </Row>
      ) : null}
      {score ? <ScoreLine score={score} testID={`channel-card-${card.id}-score`} /> : null}
      {panelNote ? <Text size="note" tone="secondary" testID={`channel-card-${card.id}-note`}>{panelNote}</Text> : null}
      {details ? (
        <Row gap="card-section" items="flex-start" flexWrap="wrap" pt="card-row" borderTopWidth={1} borderTopColor="border-soft">
          {view.handling || view.lookup ? <Column flex={1} minW={220} gap="card-row">
            <Text size="label" weight="semibold" tone="secondary">Fairy 做了什么</Text>
            {view.handling ? <Text size="note" tone={TONE_TEXT[view.handling.tone]} testID={`channel-card-${card.id}-handling`}>{view.handling.text}</Text> : null}
            {view.handling?.reason ? <Text size="note" tone="muted">{view.handling.reason}</Text> : null}
            {view.lookup ? <LookupSection id={card.id} lookup={view.lookup} reply={null} onOpenTicket={onOpenTicket} /> : null}
          </Column> : null}
          {view.reply ? (
            <Column flex={1} minW={220} gap="card-row">
              <Text size="label" weight="semibold" tone="secondary">{score ? `为什么可以这样回 · ${score.passed}/${score.total}${score.threshold ? `，自动发要 ${score.threshold}` : ''}` : '为什么可以这样回'}</Text>
              <ReplyTrack id={card.id} reply={view.reply} />
            </Column>
          ) : null}
        </Row>
      ) : null}
      {edit !== null ? (
        <Row items="center" gap="actions" pt="card-row" borderTopWidth={1} borderTopColor="border-soft">
          <Button
            label={busy === 'send_edited' ? '发出…' : '发出'}
            icon="arrow-up"
            onPress={() => act('send_edited', edit.trim())}
            disabled={busy !== null || !edit.trim()}
            size="sm"
            tone="accent"
            testID={`channel-card-${card.id}-edit-send`}
          />
          <Button
            label="取消"
            onPress={() => setEdit(null)}
            disabled={busy !== null}
            size="sm"
            variant="ghost"
            tone="neutral"
            testID={`channel-card-${card.id}-edit-cancel`}
          />
        </Row>
      ) : bar(true)}
      {error ? <Text size="note" tone="danger" testID={`channel-card-${card.id}-error`}>{error}</Text> : null}
    </Column>
  );

  return (
    <Card w="100%" rounded="xl" overflow="hidden" borderWidth={view.folded ? 0 : 1} borderColor="border" bg={view.folded ? 'transparent' : 'surface'} testID={`channel-card-${card.id}`}>
      <DisclosureView
        id={`channel-card-${card.id}`}
        label={`${card.sender.name}的消息`}
        partial={false}
        open={open}
        onOpenChange={(next) => { setOpen(next); if (!next) { setEdit(null); setDetails(false); } }}
        summary={summary}
        panel={panel}
      />
      {error && !open ? <Text px="card" pb="card" size="note" tone="danger" testID={`channel-card-${card.id}-error`}>{error}</Text> : null}
    </Card>
  );
}

// 「稍后」「不回」只在撑开的浮层里，放在操作栏右边（画布 B）。
const SIDE_ACTIONS: ReadonlySet<ChannelCardAction> = new Set(['snooze', 'dismiss']);

type DotTone = 'warning' | 'accent' | 'success' | 'muted';
const DOT_TEXT: Record<DotTone, TextTone> = { warning: 'warning-dark', accent: 'accent', success: 'success-dark', muted: 'secondary' };
const DOT_FILL: Record<DotTone, ColorToken> = { warning: 'warning', accent: 'accent', success: 'success', muted: 'text-faint' };

function Dot({ tone }: { tone: DotTone }) {
  return <Box w={6} h={6} rounded="full" bg={DOT_FILL[tone]} />;
}

// 头部右边的状态：等你的是琥珀（C-11），在干活是蓝，完成是绿，已结束是灰。
function statusOf(card: ChannelCardDto, view: ReturnType<typeof channelCardView>): { label: string; tone: DotTone } {
  if (card.state === 'auto_replied') return { label: '已代回', tone: 'success' };
  if (card.state === 'replied' || card.state === 'handled') return { label: card.state === 'handled' ? '已处理' : '已回复', tone: 'success' };
  if (view.closed) return { label: view.badge.label, tone: 'muted' };
  if (card.lookup && (card.lookup.state === 'queued' || card.lookup.state === 'running')) return { label: '进行中', tone: 'accent' };
  if (card.state === 'open') return { label: card.draft ? '等你确认' : '等你处理', tone: 'warning' };
  return { label: view.badge.label, tone: 'muted' };
}

// 头部的灰字：对话、条数和时间（「ENG-FE · 私信 · 5 条 · 15:24–15:31」）。
function metaWords(card: ChannelCardDto): string {
  const first = card.recent?.[0]?.at ?? card.createdAt;
  const last = card.recent?.at(-1)?.at ?? card.updatedAt;
  const span = card.messageCount > 1 && clockWords(first) !== clockWords(last) ? `${clockWords(first)}–${clockWords(last)}` : clockWords(last);
  return [card.laneLabel, card.messageCount > 1 ? `${card.messageCount} 条` : null, span].filter(Boolean).join(' · ');
}

type FairyLineView = { lead: string; rest: string | null; progress: number | null | 'unknown' };

// Fairy 的那一行：600 的一句结论，后面是草稿、进度或者一句说明（主题 11.2 第 3 条）。
function fairyLine(card: ChannelCardDto, view: ReturnType<typeof channelCardView>, lead?: LeadStatus): FairyLineView {
  const lookup = card.lookup;
  const active = lookup && (lookup.state === 'queued' || lookup.state === 'running');
  const at = (value: string | null) => clockWords(value) ?? '';
  if (card.state === 'auto_replied') return { lead: `Fairy ${at(card.resolvedAt)} 替你回了`, rest: view.lookup?.track.details.join(' · ') || null, progress: null };
  if (card.state === 'replied') {
    return card.outcome?.by === 'lead'
      ? { lead: `Fairy ${at(card.resolvedAt)} 照你的话回了`, rest: null, progress: null }
      : { lead: `你 ${at(card.resolvedAt)} 发出了 Fairy 的草稿`, rest: view.disclosure ? '开头带助手署名' : null, progress: null };
  }
  if (card.state === 'resolved_elsewhere') return { lead: `你在 ${card.sourceLabel} 里自己回了`, rest: `${at(card.resolvedAt)} · Fairy 的草稿已作废`, progress: null };
  if (card.state === 'replying_self') return { lead: `等你在 ${card.sourceLabel} 里回复`, rest: '回了以后这张卡自动结束', progress: null };
  if (card.state === 'dismissed') return { lead: '你选了不回', rest: null, progress: null };
  if (card.state === 'handled') return { lead: '已照你的话处理', rest: card.outcome?.note ?? null, progress: null };
  if (active) {
    const what = lookup.playbook === 'review' ? `去 review ${lookup.repos.join('、')}`.trim() : '去查';
    return { lead: lookup.ticketId ? `Fairy 派了 #${lookup.ticketId} ${what}` : 'Fairy 在安排工单', rest: view.lookup?.track.details.join(' · ') || null, progress: 'unknown' };
  }
  if (card.draft) {
    const review = lookup?.playbook === 'review' && lookup.state === 'finished';
    const lead = review ? 'Fairy review 完了，建议这样回' : card.messageCount > 1 ? `Fairy 把 ${card.messageCount} 条当成一件事，建议这样回` : 'Fairy 建议这样回';
    return { lead, rest: oneLine(card.draft.text), progress: null };
  }
  const handling = card.handling?.lead;
  // 统一消息事件工单 06：没有期限，系统不替 Lead 定。Lead 还没处理时写排队中，不写几点前兜底。
  if (handling && handling.decision === null) {
    // Lead 的模型调用在失败（顶栏是降级，失败次数大于 0）：卡不是在排队，是 Lead 卡住了，写原因（2026-10-28：上下文满了的
    // 40 分钟里卡上一直写「排队中」，用户以为 Lead 在忙别的）。只是压缩失败、模型调用还好时 Lead 照常工作，照旧写排队中。
    if (lead?.state === 'degraded' && lead.failures > 0) {
      return { lead: 'Fairy 卡住了，恢复后处理', rest: leadModelFailureShortLabel(classifyLeadModelError(lead.detail ?? '')), progress: null };
    }
    const intent = card.handling?.authority?.intent;
    return { lead: '排队中，等 Fairy 处理', rest: intent ? `看出是${CHANNEL_INTENT_LABELS[intent]}` : null, progress: null };
  }
  return { lead: view.handling?.text ?? 'Fairy 看过了', rest: view.note, progress: null };
}

// 结论和后半句连成一段（2026-10-28 改版稿第 3 组）：第二行从 Fairy 标记右边的起点接着排，不缩在结论右边。
function FairyRow({ line, oneLine: single = false, testID }: { line: FairyLineView; oneLine?: boolean; testID?: string }) {
  return (
    <Column gap="text-stack" testID={testID}>
      <Row items="flex-start" gap="icon-label" minW={0}>
        <FairyMark />
        <Text flex={1} minW={0} size="secondary" tone="strong" numberOfLines={single ? 1 : 3}>
          <Text size="secondary" weight="semibold" tone="default">{line.lead}</Text>
          {line.rest ? `　${line.rest}` : null}
        </Text>
        {line.progress === 'unknown' && single ? <Box w={64} shrink={0} self="center"><ProgressBar /></Box> : null}
      </Row>
      {line.progress === 'unknown' && !single ? <ProgressBar /> : null}
    </Column>
  );
}

// 对方的话，一行（收起态）：最新那条放在别人说话的气泡里，多条时前面一个「N 条」小标签。
function LatestMessage({ card }: { card: ChannelCardDto }) {
  return (
    <Row items="center" gap="inline-item" minW={0} testID={`channel-card-${card.id}-latest`}>
      {card.messageCount > 1 ? (
        <Box shrink={0} bg="surface-muted" rounded="full" px="inline-item" testID={`channel-card-${card.id}-count`}>
          <Text size="meta" weight="semibold" tone="strong">{`${card.messageCount} 条`}</Text>
        </Box>
      ) : null}
      <Bubble><Text size="message-lead" numberOfLines={1}>{plainLine(card, card.recent?.at(-1)?.text ?? card.excerpt)}</Text></Bubble>
    </Row>
  );
}

// 撑开以后：对方连发的几条叠在同一个气泡里，每条一个淡时间，更早的写「更早的 N 条」（画布状态 7）。
function MessageStack({ card }: { card: ChannelCardDto }) {
  const recent = card.recent?.length ? card.recent.slice(-3) : [{ at: card.updatedAt, text: card.excerpt }];
  const earlier = Math.max(0, card.messageCount - recent.length);
  return (
    <Bubble wide testID={`channel-card-${card.id}-messages`}>
      {earlier > 0 ? <Text size="meta" tone="secondary">{`更早的 ${earlier} 条`}</Text> : null}
      {recent.map((message, index) => (
        <Row key={`${index}:${message.at}`} items="flex-end" gap="side-item">
          <Box flex={1} minW={0}><MarkdownMessage markdown={sourceMarkdown(card, message.text)} size="message-lead" breaks /></Box>
          {recent.length > 1 ? <Text size="meta" mono tone="muted" shrink={0}>{clockWords(message.at) ?? ''}</Text> : null}
        </Row>
      ))}
    </Bubble>
  );
}

// 别人说话的气泡：accent-soft 底，左上角 4、其余 14（主题 S-4、R-5，组件规格）。
function Bubble({ children, wide = false, testID }: { children: ReactNode; wide?: boolean; testID?: string }) {
  return (
    <Column
      testID={testID}
      {...(wide ? {} : { self: 'flex-start' as const, shrink: 1, minW: 0 })}
      bg="accent-soft"
      px="inset-x"
      py="inset-y"
      gap="text-stack"
      borderTopLeftRadius={4}
      borderTopRightRadius={14}
      borderBottomLeftRadius={14}
      borderBottomRightRadius={14}
    >
      {children}
    </Column>
  );
}

type ScoreView = { value: string; threshold: string | null; squares: SegmentItem[]; passed: number; total: number; weakest: string | null };

// 信心：五项检查各一格（过了绿、不够强琥珀、没过红），和信心的数值、自动发的门槛。
function scoreOf(card: ChannelCardDto, view: ReturnType<typeof channelCardView>): ScoreView | null {
  const reply = view.reply;
  if (!reply || !reply.checks.length) return null;
  const confidence = card.handling?.reply?.confidence ?? card.lookup?.confidence?.value ?? null;
  const threshold = card.handling?.reply?.threshold ?? card.lookup?.confidence?.threshold ?? null;
  const squares = reply.checks.map((check) => ({ label: check.label, tone: check.mark === '✓' ? 'success' as const : check.mark === '△' ? 'warning' as const : 'danger' as const }));
  const weakest = reply.checks.find((check) => check.mark !== '✓');
  return {
    value: confidence === null ? '—' : confidence.toFixed(2),
    threshold: threshold === null ? null : threshold.toFixed(2),
    squares,
    passed: reply.checks.filter((check) => check.mark === '✓').length,
    total: reply.checks.length,
    weakest: weakest ? `差在「${weakest.label}」${weakest.detail ? `：${weakest.detail}` : ''}` : null,
  };
}

function Squares({ score }: { score: ScoreView }) {
  return (
    <Row gap="text-stack" items="center">
      {score.squares.map((square, index) => (
        <Box key={index} w={8} h={8} rounded={2} bg={square.tone === 'success' ? 'success' : square.tone === 'warning' ? 'warning' : 'danger'} />
      ))}
    </Row>
  );
}

// 信心胶囊（收起态操作栏的最右边）：五格加「信心 0.71」。
function ConfidencePill({ score, testID }: { score: ScoreView; testID?: string }) {
  return (
    <Row testID={testID} items="center" gap="icon-label" rounded="full" borderWidth={1} borderColor="border" px="inline-item" py="text-stack">
      <Squares score={score} />
      <Text size="meta" weight="semibold" tone="strong">{`信心 ${score.value}`}</Text>
    </Row>
  );
}

// 撑开以后的一行：五格、几项过了、差在哪里、自动发要多少（画布 B）。
function ScoreLine({ score, testID }: { score: ScoreView; testID?: string }) {
  const words = [`${score.passed}/${score.total}`, score.weakest, score.threshold ? `自动发要 ${score.threshold}` : null].filter(Boolean).join(' · ');
  return (
    <Row testID={testID} items="center" gap="icon-label">
      <Squares score={score} />
      <Text flex={1} minW={0} size="meta" tone="secondary" numberOfLines={2}>{words}</Text>
    </Row>
  );
}

// 撤回按钮写还剩多久（画布状态 6）：每秒更新。
function labelOf(action: ChannelCardAction, label: string, card: ChannelCardDto, now?: Date): string {
  if (action === 'send_draft') return '发出';
  if (action === 'undo_auto_reply' && card.revokeUntil) {
    const left = Math.max(0, Date.parse(card.revokeUntil) - (now ?? new Date()).getTime());
    return `撤回 还剩 ${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}`;
  }
  return label;
}

function CardButton({ card, action, label, primary, busy, onPress, suffix }: {
  card: ChannelCardDto; action: ChannelCardAction; label: string; primary: boolean; busy: ChannelCardAction | null;
  onPress: (action: ChannelCardAction) => void; suffix: string;
}) {
  return (
    <Button
      label={busy === action ? `${label}…` : label}
      onPress={() => onPress(action)}
      disabled={busy !== null}
      size="sm"
      {...(primary && action === 'send_draft' ? { icon: 'arrow-up' as const } : {})}
      variant={primary ? 'solid' : 'ghost'}
      tone={primary ? 'accent' : 'neutral'}
      testID={`channel-card-${card.id}-${action}${suffix}`}
    />
  );
}

// 对方的原文按格式画（2026-10-28）：Slack 的 mrkdwn 先换成 Markdown；别的来源当 Markdown。
function sourceMarkdown(card: ChannelCardDto, text: string): string {
  return card.source === 'slack' ? slackToMarkdown(text) : text;
}

function plainLine(card: ChannelCardDto, text: string): string {
  return card.source === 'slack' ? slackPlainText(text) : oneLine(text);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// 会话里的一张外部来源的卡（工单 11）。卡的内容从 store 取（服务端改卡时整份重取），动作经 runtime 发到网关；
// 点工单号打开代查工单。
export function ChannelCardSlot({ cardId }: { cardId: number }) {
  const runtime = useCompanionRuntime();
  const openTicket = useOpenTicket();
  const card = useControlPlaneStore((state) => state.channelCards.find((candidate) => candidate.id === cardId));
  const lead = useControlPlaneStore((state) => state.overview?.lead);
  if (!card) return null;
  return (
    <Box w="100%">
      <ChannelMessageCard
        card={card}
        lead={lead}
        onAction={(action, text) => runtime.actOnChannelCard(card.id, action, text)}
        onOpenTicket={openTicket}
      />
    </Box>
  );
}
