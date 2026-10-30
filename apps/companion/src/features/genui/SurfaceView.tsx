import {
  Badge, Box, Button, Card, ChoiceGroup, Column, FactList, Group, Icon, MediaRow, Pressable, QuotedMessages, Row, Segments, Text, Tile,
  dataToneBadge, dataToneText, type BadgeTone, type QuotedMessage, type SegmentItem, type TileEmphasis,
} from '@pi-lead-child/components';
import {
  surfaceNeedsNewerCatalog, validateUiSurface, type UiBinding, type UiNode, type UiSurface, type UiTone, type UserActionRequest,
} from '@pi-lead-child/protocol';
import { createContext, useContext, type ReactNode } from 'react';

import { useCompanionRuntime, useControlPlaneStore, useWorkspaceStore } from '../../state/CompanionStateProvider';
import { useConnectionState, useReloadApp, useServedWebVersion, useTicketInterventions } from '../../state/hooks';
import { ChannelCardSlot } from '../chat/ChannelMessageCard';
import { InterventionSlot } from '../chat/InterventionSlot';
import { ReminderCard } from '../chat/ReminderCard';
import { useOpenTicket } from '../chat/useOpenTicket';
import { ConnectionConfirmCard, ConnectionConnectCard } from './ConnectionCards';
import {
  BarChartView, DataTableView, ProgressView, StatsView, StepsView, TimelineView,
  type BarChartProps, type DataTableProps, type ProgressProps, type StatsProps, type StepsProps, type TimelineProps,
} from './InfoViews';
import { MemorySwitchConfirmCard } from './MemoryCards';
import {
  ActionButton, ActionGroup, DisclosureView, FieldView, SurfaceFormProvider, useBinding,
  type ActionProps, type ActionTargets, type DisclosureProps, type FieldProps,
} from './SurfaceControls';
import { StandingOrderChangeConfirmCard } from './StandingOrderCards';
import { useTicketRef } from './useTicketRef';
import { UserActionCard } from './UserActionCard';

// Lead 用 render_ui 画的富交互卡片（generative UI，2026-10-15 用户决定，.scratch/generative-ui/spec.md）。
// 卡片是数据：这里用 App 自己的组件画出组件目录里的每种组件（protocol 的 ui-surfaces.ts）。
// 先用和服务端同一个 validateUiSurface 再校验一次，不合格就只显示 fallbackText，不画半截。
// 不合格是因为卡里有这个版本还没有的组件时，fallbackText 前面再说明要刷新（NeedsNewerApp）。
// 工单和决策只按编号引用：状态从 TicketSummary 和决策请求实时读取，旧卡片不会显示过期的状态。
// 外观是方案 A 的决定卡：有待做的决定时整张卡是琥珀色的边，工单头写「等你决定」。
// partial：模型还在写这张卡（流式），先画已经完整的部分，说一句「正在生成…」，选项先不能点。
export function SurfaceView({ surface, partial = false }: { surface: UiSurface; partial?: boolean }) {
  const checked = validateUiSurface(surface);
  if (!checked.ok) {
    if (surfaceNeedsNewerCatalog(checked)) return <NeedsNewerApp fallbackText={surface.fallbackText} />;
    return <Text size="body">{surface.fallbackText}</Text>;
  }
  const valid = checked.surface;
  const byId = new Map(valid.nodes.map((node) => [node.id, node]));
  const asksUser = valid.nodes.some((node) => node.type === 'ChoiceGroup' || node.type === 'UserAction');
  // 根节点是贴边的 Media（票根）：卡片不留内边距，前导贴住卡片的边，正文自己留内边距（MediaRow 的 bleed）。
  const root = byId.get(valid.root)!;
  // 根节点是对象组件：它自己就是一整张卡（和系统卡同一张），外面不再套一层。
  if (root.type === 'Reminder' || root.type === 'ChannelCard' || root.type === 'Intervention') return <ObjectNode node={root} />;
  const bleed = !partial && bleedsToEdge(root, byId);
  return (
    <Card
      testID={`surface-${valid.id}`}
      w="100%"
      rounded="xl"
      // 票根卡不裁掉边外的内容：打孔线两头的半圆缺口压在卡片的边线上。日历页自己圆左边的两个角（Tile 的 attached）。
      overflow={bleed ? 'visible' : 'hidden'}
      borderWidth={asksUser ? 1.5 : 1}
      borderColor={asksUser ? 'warning-line' : 'border-soft'}
      {...(bleed ? {} : { px: 'card' as const, py: 'card' as const })}
    >
      <CardInfo.Provider value={cardInfo(valid.nodes, byId)}>
        <SurfaceFormProvider>
          <Column gap="card-row">
            <SurfaceNode node={root} byId={byId} partial={partial} bleed={bleed} />
            {partial ? <Text size="note" tone="secondary">正在生成…</Text> : null}
          </Column>
        </SurfaceFormProvider>
      </CardInfo.Provider>
    </Card>
  );
}

// 卡片用了这个版本还没有的组件（2026-10-20）：服务端校验过这张卡，它的组件目录比 App 新。按错误的 code 判断，不读文字。
// fallbackText 前面说一句原因。只有 daemon 提供的网页和这个页面不一样时，才说「刷新后显示」并给刷新按钮：
// 部署了 daemon、没跑 build:web 时，刷新拿到的还是这个页面（2026-10-20 验收：点了刷新还是纯文本）。
// 版本一样或者不知道时，只说这张卡用了当前版本还不支持的组件，不承诺刷新有用。
// 用户收起顶栏的提示不影响这里。不自动刷新：用户可能正在输入。
function NeedsNewerApp({ fallbackText }: { fallbackText: string }) {
  const served = useServedWebVersion();
  const reload = useReloadApp();
  const refresh = served === 'newer' ? reload : null;
  return (
    <Column gap="text-stack">
      <Row testID="surface-needs-update" items="center" gap="inline-item" flexWrap="wrap">
        <Text size="secondary" tone="secondary">{refresh ? '这张卡需要新版本，刷新后显示' : '这张卡用了当前版本还不支持的组件'}</Text>
        {refresh ? <Button label="刷新" onPress={refresh} variant="link" tone="accent" size="xs" /> : null}
      </Row>
      <Text size="body">{fallbackText}</Text>
    </Column>
  );
}

// 卡片里的按钮改的是哪张工单（浮层里的预览用），和卡片自己绑定了哪些「工单:字段」（有绑定时 Field 不再另写预览）。
type CardFacts = { targets: ActionTargets; bound: ReadonlySet<string> };
const CardInfo = createContext<CardFacts>({ targets: {}, bound: new Set() });

function actionTicket(node: UiNode | undefined): number | null {
  if (node?.type !== 'Action') return null;
  const target = node.props.target as { type: string; id: string | number };
  const id = Number(target.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function cardInfo(nodes: readonly UiNode[], byId: ReadonlyMap<string, UiNode>): CardFacts {
  const targets: ActionTargets = {};
  for (const node of nodes) {
    const ticket = actionTicket(node);
    if (ticket !== null) targets[node.id] = ticket;
  }
  void byId;
  const bound = new Set(nodes.map((node) => node.props.bind as UiBinding | undefined).filter(Boolean).map((bind) => `${bind!.ticket}:${bind!.field}`));
  return { targets, bound };
}

// 整张卡是一张票根：根节点是贴边的 Media，或者 Disclosure 的收起态只有一个贴边的 Media。卡片不留内边距（MediaRow 的 bleed）。
function bleedsToEdge(root: UiNode, byId: ReadonlyMap<string, UiNode>): boolean {
  const stub = (node: UiNode | undefined) => (node?.type === 'Media' || node?.type === 'Item') && node.props.attach === true;
  if (stub(root)) return true;
  if (root.type !== 'Disclosure') return false;
  const detail = new Set(root.props.detail as string[]);
  const summary = (root.children ?? []).filter((id) => !detail.has(id));
  return summary.length === 1 && stub(byId.get(summary[0]!));
}

// 这个节点和它下面第一个带状态绑定的节点的绑定：Disclosure 用它判断卡片结束了没有。
function firstBinding(node: UiNode, byId: ReadonlyMap<string, UiNode>): UiBinding | undefined {
  if (node.props.bind) return node.props.bind as UiBinding;
  for (const id of node.children ?? []) {
    const child = byId.get(id);
    const found = child ? firstBinding(child, byId) : undefined;
    if (found) return found;
  }
  return undefined;
}

// Lead 只选三档；具体的值是语义 token（2026-10-22）：sm 是并排的芯片，md 是一个区块里相邻的组件，lg 是卡片里的区块之间。
// 随会话区域的密度和外观偏好一起变。
const GAP = { sm: 'chips', md: 'card-row', lg: 'card-section' } as const;

function SurfaceNode({ node, byId, partial, bleed = false }: {
  node: UiNode; byId: ReadonlyMap<string, UiNode>; partial: boolean; bleed?: boolean;
}): ReactNode {
  const children = (node.children ?? []).map((id) => byId.get(id)).filter((child): child is UiNode => Boolean(child));
  const props = node.props as Record<string, unknown>;
  switch (node.type) {
    case 'Stack': {
      const row = props.direction === 'row';
      const gap = GAP[(props.gap as keyof typeof GAP | undefined) ?? 'md'];
      const Layout = row ? Row : Column;
      // 一排全是按钮时是操作组：靠右排（视觉稿：取消在主按钮左边，都在面板右下角），要确认时整排换成一行确认。
      if (row && children.length > 0 && children.every((child) => child.type === 'Action')) {
        return <ActionGroup partial={partial} actions={children.map((child) => ({ id: child.id, ...(child.props as unknown as Omit<ActionProps, 'id'>) }))} />;
      }
      return (
        <Layout gap={gap} {...(row ? { flexWrap: 'wrap', items: 'center' } as const : {})}>
          {children.map((child) => <SurfaceNode key={child.id} node={child} byId={byId} partial={partial} />)}
        </Layout>
      );
    }
    case 'Section':
      return (
        <Column gap="card-row">
          {typeof props.title === 'string' ? <Text size="eyebrow" weight="semibold" tone="secondary">{props.title}</Text> : null}
          {children.map((child) => <SurfaceNode key={child.id} node={child} byId={byId} partial={partial} />)}
        </Column>
      );
    case 'Text':
      return <SurfaceText text={String(props.text)} variant={props.variant as string | undefined} tone={props.tone as UiTone | undefined} bind={props.bind as UiBinding | undefined} />;
    case 'Badge':
      return <Box self="flex-start"><Badge label={String(props.text)} tone={dataToneBadge[(props.tone as UiTone | undefined) ?? 'neutral']} /></Box>;
    case 'FactList':
      return <FactListView items={props.items as FactItem[]} />;
    case 'TicketRef':
      return <TicketHead ticketId={Number(props.ticket)} />;
    case 'SourceQuote':
      return (
        <SourceQuote
          ticketId={Number(props.ticket)}
          text={typeof props.text === 'string' ? props.text : null}
          label={typeof props.label === 'string' ? props.label : null}
          truncated={props.truncated === true}
        />
      );
    case 'ChoiceGroup':
      return <DecisionChoices {...(props as unknown as ChoiceGroupProps)} partial={partial} />;
    // 连接卡：Lead 请你连接或重新授权一个账号；写入确认：你允许以后 daemon 才执行（packages/protocol 的 connections.ts）。
    case 'ConnectionConnect':
      return <ConnectionConnectCard connection={String(props.connection)} reason={typeof props.reason === 'string' ? props.reason : undefined} />;
    case 'ConnectionConfirm':
      return <ConnectionConfirmCard confirmation={String(props.confirmation)} />;
    // 记忆切换要你确认：重建索引，或者笔记要发给新的远程服务（packages/protocol 的 memory.ts）。
    case 'MemorySwitchConfirm':
      return <MemorySwitchConfirmCard switch={String(props.switch)} />;
    // Lead 提议的常设指令修改要你批准（更放开的那一档，packages/protocol 的 standing-orders-wire.ts）。
    case 'StandingOrderChangeConfirm':
      return <StandingOrderChangeConfirmCard approval={Number(props.approval)} />;
    // 展示信息的组件（目录 v2，2026-10-19）：表格、指标、步骤、进度、时间线、条形图（InfoViews.tsx 转成 packages/components 的组件）。
    case 'DataTable':
      return <DataTableView id={node.id} {...(props as unknown as DataTableProps)} />;
    case 'Stats':
      return <StatsView id={node.id} {...(props as unknown as StatsProps)} />;
    case 'Steps':
      return <StepsView id={node.id} {...(props as unknown as StepsProps)} />;
    case 'Progress':
      return <ProgressView id={node.id} {...(props as unknown as ProgressProps)} />;
    case 'Timeline':
      return <TimelineView id={node.id} {...(props as unknown as TimelineProps)} />;
    case 'BarChart':
      return <BarChartView id={node.id} {...(props as unknown as BarChartProps)} />;
    // v3 积木（2026-10-27）：图块、前导 + 正文、一排小格、别人说的话（packages/components 的 Tile、MediaRow、Segments、QuotedMessages）。
    case 'Tile':
      return <SurfaceTile node={node} />;
    case 'Media': {
      const [lead, body] = children;
      const attach = props.attach === true;
      return (
        <MediaRow
          testID={`surface-media-${node.id}`}
          attach={attach}
          bleed={bleed}
          align={props.align === 'center' ? 'center' : 'start'}
          // 整张卡是一张票根时，图块贴边、没有自己的边框（Tile 的 attached）。
          lead={lead ? (attach && bleed && lead.type === 'Tile' ? <SurfaceTile node={lead} attached /> : <SurfaceNode node={lead} byId={byId} partial={partial} />) : null}
        >
          {body ? <SurfaceNode node={body} byId={byId} partial={partial} /> : null}
        </MediaRow>
      );
    }
    case 'Reminder':
    case 'ChannelCard':
    case 'Intervention':
      return <ObjectNode node={node} />;
    case 'Item':
      return <SurfaceItem node={node} byId={byId} partial={partial} bleed={bleed} />;
    case 'Disclosure':
      return <SurfaceDisclosure node={node} byId={byId} partial={partial} bleed={bleed} />;
    // 同类合并（2026-10-28）：收起一行写件数，点开是浮层，children 一件一行。件数由 children 数出来。
    case 'Group':
      return (
        <Group
          testID={`surface-group-${node.id}`}
          label={String(props.label ?? '')}
          tag={typeof props.tag === 'string' ? props.tag : null}
          tone={props.tone === 'warning' ? 'warning' : 'neutral'}
          entries={children.map((child) => ({ key: child.id, content: <SurfaceNode node={child} byId={byId} partial={partial} /> }))}
        />
      );
    case 'Action':
      return <ActionButton id={node.id} partial={partial} {...(props as unknown as Omit<ActionProps, 'id' | 'partial'>)} />;
    case 'Field':
      return <SurfaceField node={node} byId={byId} />;
    case 'Segments':
      return (
        <Segments
          testID={`surface-segments-${node.id}`}
          items={props.items as SegmentItem[]}
          {...(typeof props.summary === 'string' ? { summary: props.summary } : {})}
        />
      );
    // 原文由服务端定稿时从外部消息卡填（sender、messages）。流式中途还没有原文：不画。
    case 'Message':
      return Array.isArray(props.messages) && props.messages.length ? (
        <QuotedMessages
          testID={`surface-message-${node.id}`}
          sender={typeof props.sender === 'string' ? props.sender : '对方'}
          messages={props.messages as QuotedMessage[]}
          total={typeof props.total === 'number' ? props.total : props.messages.length}
          mode={props.mode === 'stack' ? 'stack' : 'latest'}
        />
      ) : null;
    // 请你做一件事（通用，protocol 的 user-actions.ts）：按 kind 选控件，控件只做这一件事。
    case 'UserAction':
      return <UserActionCard action={props.action as UserActionRequest} />;
    // 目录里有、这个版本还不会画的组件：不画。整张卡不合格时上面已经只显示 fallbackText。
    default:
      return null;
  }
}

// 模式组件「事项」（patterns.md P9.5）：前导图块 + 标题和一行说明（或者一句话）+ 右边一个按钮；有细节时可以点开。
// 用的是和积木同一套组件（Tile、MediaRow、DisclosureView）。贴边（attach）时是票根，整张卡是根节点时贴住卡片的边。
function SurfaceItem({ node, byId, partial, bleed }: { node: UiNode; byId: ReadonlyMap<string, UiNode>; partial: boolean; bleed: boolean }) {
  const facts = useContext(CardInfo);
  const props = node.props as {
    lead: Record<string, unknown>; attach?: boolean; title?: string; text?: string; meta?: string; metaBind?: UiBinding; label?: string;
  };
  const children = (node.children ?? []).map((id) => byId.get(id)).filter((child): child is UiNode => Boolean(child));
  const button = children.find((child) => child.type === 'Action');
  const detail = children.filter((child) => child.type !== 'Action');
  const live = useBinding(props.metaBind);
  const meta = live.text ?? props.meta;
  const lead = { id: `${node.id}-lead`, type: 'Tile', props: props.lead } as UiNode;
  const attach = props.attach === true;
  const edge = attach && bleed;
  const opens = detail.length > 0;
  const body = (
    <Row items="center" gap="side-item">
      <Column flex={1} minW={0} gap="text-stack">
        {props.title ? <Text size="card-title" weight="bold" numberOfLines={2}>{props.title}</Text> : null}
        {props.text ? <Text size="body">{props.text}</Text> : null}
        {meta ? <Text size="note" tone={props.metaBind && live.text ? 'accent' : 'secondary'} numberOfLines={1}>{meta}</Text> : null}
      </Column>
      {button ? <ActionButton id={button.id} partial={partial} {...(button.props as unknown as Omit<ActionProps, 'id' | 'partial'>)} /> : null}
      {opens && !button ? <Icon name="chevron-down" size={14} color="text-muted" weight="semibold" /> : null}
    </Row>
  );
  // 有一句话（text）时顶端对齐（比分）；只有标题和说明时居中（航班、待办）。
  const align = props.text ? 'start' : 'center';
  const row = (expanded = false) => (
    <MediaRow
      testID={`surface-item-${node.id}${expanded ? '-open' : ''}`}
      attach={attach}
      bleed={edge}
      notches={!expanded}
      align={align}
      lead={<SurfaceTile node={lead} attached={edge} expanded={expanded && edge} />}
    >
      {body}
    </MediaRow>
  );
  if (!opens) return row();
  const nodes = <Column gap="card-section">{detail.map((child) => <SurfaceNode key={child.id} node={child} byId={byId} partial={partial} />)}</Column>;
  const bound = props.lead.bind as UiBinding | undefined;
  return (
    <ItemDisclosure
      id={node.id}
      label={props.label ?? props.title ?? '细节'}
      partial={partial}
      bind={bound}
      targets={facts.targets}
      summary={row()}
      panel={(
        <Column>
          <Box {...(edge ? {} : { p: 'card' as const })}>{row(true)}</Box>
          {/* spacing-exempt: 分隔线内缩同面板内边距 */}
          <Box h={1} mx={16} bg="border-soft" />
          <Box p="card">{nodes}</Box>
        </Column>
      )}
    />
  );
}

function ItemDisclosure({ bind, ...rest }: Omit<DisclosureProps, 'ended'> & { bind?: UiBinding }) {
  const bound = useBinding(bind);
  return <DisclosureView {...rest} ended={bound.ended} />;
}

// 对象组件 Reminder：和会话里的系统提醒卡是同一个组件，只按编号取数据。
// 对象组件（三层的最上层）：账本里的一个对象，只有编号。画成和会话里同一张系统卡：提醒卡、外部消息卡、介入请求卡。
function ObjectNode({ node }: { node: UiNode }) {
  const props = node.props as Record<string, unknown>;
  if (node.type === 'ChannelCard') return <ChannelCardObject cardId={Number(props.card)} />;
  if (node.type === 'Intervention') {
    // ticket、checkpoint 是服务端在 render_ui 定稿时填的。没有 ticket 的旧卡画不出来，只留说明。
    if (typeof props.ticket !== 'number') return <Text size="secondary" tone="secondary">{`${props.kind === 'approval' ? '审批' : '决定'} #${String(props.id)}`}</Text>;
    return (
      <InterventionSlot
        kind={props.kind === 'approval' ? 'approval' : 'decision'}
        id={Number(props.id)}
        ticket={props.ticket}
        {...(typeof props.checkpoint === 'number' ? { checkpoint: props.checkpoint } : {})}
      />
    );
  }
  return <ReminderObject reminder={Number(props.reminder)} />;
}

// 外部消息卡：这台设备的会话里有这张卡时，就是会话里那一张；还没同步到时先写一行占位。
function ChannelCardObject({ cardId }: { cardId: number }) {
  const held = useControlPlaneStore((state) => state.channelCards.some((card) => card.id === cardId));
  if (!held) return <Text testID={`channel-card-slot-${cardId}`} size="secondary" tone="secondary">{`外部消息卡 #${cardId} 正在同步。`}</Text>;
  return <ChannelCardSlot cardId={cardId} />;
}

function ReminderObject({ reminder }: { reminder: number }) {
  return <ReminderCard view={{ reminderId: reminder, title: null, remindAt: null, stage: null, event: null, fallback: null }} />;
}

function SurfaceField({ node, byId }: { node: UiNode; byId: ReadonlyMap<string, UiNode> }) {
  const facts = useContext(CardInfo);
  const props = node.props as unknown as Omit<FieldProps, 'id' | 'previewedByCard'>;
  const ticket = actionTicket(byId.get(props.for));
  return <FieldView id={node.id} {...props} previewedByCard={ticket !== null && facts.bound.has(`${ticket}:${props.param}`)} />;
}

function SurfaceTile({ node, attached = false, expanded = false }: { node: UiNode; attached?: boolean; expanded?: boolean }) {
  const props = node.props as Record<string, unknown>;
  // 绑定了工单时，色调跟着它现在的状态；绑定的是时间时，说明行实时写这个时间（取不到时用快照）。
  const bind = props.bind as UiBinding | undefined;
  const live = useBinding(bind);
  // 绑定时间、format 是 date：图块就是一页日历，小标题写月份、大值写日期，改了时间跟着变。
  // 浮层里选了新时间、还没按下时，日历页先换成新的一天（强调色），最下面划掉原来那天。
  // 展开的日历页多写星期和时刻（视觉稿：周五 / 30 / 14:00）。其他时间格式写在说明行。取不到时都用 Lead 写的快照。
  const calendar = bind?.field === 'remindAt' && bind.format === 'date' && live.at ? live.pending ?? live.at : null;
  const clock = (at: Date) => `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const weekday = (at: Date) => `周${'日一二三四五六'[at.getDay()]}`;
  const caption = calendar ? (expanded ? clock(calendar) : props.caption)
    : bind && bind.field !== 'stage' && live.text ? live.pendingText ?? live.text : props.caption;
  const eyebrow = calendar ? `${calendar.getMonth() + 1}月` : props.eyebrow;
  const value = calendar ? calendar.getDate() : props.value as number | string;
  const tone = live.tone ?? (props.tone as UiTone | undefined);
  const was = calendar && live.pending && live.at ? `原 ${weekday(live.at)} ${live.at.getDate()}` : undefined;
  return (
    <Tile
      testID={`surface-tile-${node.id}`}
      value={value}
      attached={attached}
      highlight={Boolean(live.pending)}
      {...(calendar && expanded ? { above: weekday(calendar) } : {})}
      {...(was ? { was } : {})}
      {...(typeof eyebrow === 'string' ? { eyebrow } : {})}
      {...(typeof caption === 'string' ? { caption } : {})}
      {...(tone ? { tone } : {})}
      // 展开的日历页加宽、日期放大（视觉稿：56 → 72，日期 20 → 30）：用大一档的图块。
      {...(expanded ? { size: 'md' as const } : props.size ? { size: props.size as 'sm' | 'md' } : {})}
      {...(props.emphasis ? { emphasis: props.emphasis as TileEmphasis } : {})}
    />
  );
}

// 收起和展开：不在 detail 里的子节点是收起态，detail 的在浮层里。
// 卡片是一张票根时（收起态只有一个贴边的 Media，前导是 Tile）：浮层里日历页那一栏延伸到整个浮层并放大，
// 正文和 detail 都排在打孔线右边（视觉稿提醒卡的「点开后」）。别的卡：收起态在上，一条细线，detail 在下。
function SurfaceDisclosure({ node, byId, partial, bleed }: { node: UiNode; byId: ReadonlyMap<string, UiNode>; partial: boolean; bleed: boolean }) {
  const facts = useContext(CardInfo);
  const detailIds = new Set(node.props.detail as string[]);
  const children = (node.children ?? []).map((id) => byId.get(id)).filter((child): child is UiNode => Boolean(child));
  const summary = children.filter((child) => !detailIds.has(child.id));
  const detail = children.filter((child) => detailIds.has(child.id));
  const bound = useBinding(firstBinding(node, byId));
  const nodes = (list: UiNode[], edge = false) => list.map((child) => <SurfaceNode key={child.id} node={child} byId={byId} partial={partial} bleed={edge} />);
  const stub = bleed && summary.length === 1 ? summary[0]! : null;
  const lead = stub?.children?.[0] ? byId.get(stub.children[0]) : undefined;
  const body = stub?.children?.[1] ? byId.get(stub.children[1]) : undefined;
  const panel = stub && lead?.type === 'Tile' && body ? (
    <MediaRow attach bleed notches={false} testID={`surface-media-${stub.id}-open`} lead={<SurfaceTile node={lead} attached expanded />}>
      <Column gap="card-section">
        <SurfaceNode node={body} byId={byId} partial={partial} />
        {nodes(detail)}
      </Column>
    </MediaRow>
  ) : (
    <Column>
      <Column gap="card-row" {...(bleed ? {} : { p: 'card' as const })}>{nodes(summary, bleed)}</Column>
      {/* spacing-exempt: 分隔线内缩同面板内边距 */}
      <Box h={1} mx={16} bg="border-soft" />
      <Column p="card" gap="card-section">{nodes(detail)}</Column>
    </Column>
  );
  return (
    <DisclosureView
      id={node.id}
      label={String(node.props.label)}
      partial={partial}
      ended={bound.ended}
      targets={facts.targets}
      summary={<Column gap="card-row">{nodes(summary, bleed)}</Column>}
      panel={panel}
    />
  );
}

function SurfaceText({ text, variant, tone, bind }: { text: string; variant?: string; tone?: UiTone; bind?: UiBinding }) {
  const live = useBinding(bind);
  if (live.text) text = live.text;
  const color = dataToneText[tone ?? 'neutral'];
  // 浮层里选了新时间、还没按下：旧的划掉，箭头后面是新的（视觉稿：~~周四 14:00~~ → 周五 14:00）。剩余时间直接写到新时间的。
  if (live.pendingText) {
    const size = variant === 'title' ? 'card-title' : variant === 'caption' ? 'note' : 'body';
    if (bind?.format === 'remaining' || bind?.format === undefined) return <Text size={size} tone="accent">{live.pendingText}</Text>;
    return (
      <Row items="center" gap="icon-label" flexWrap="wrap">
        <Text size={size} tone="muted" textDecorationLine="line-through">{text}</Text>
        <Text size={size} tone="secondary">→</Text>
        <Text size={size} weight="semibold" tone="accent">{live.pendingText}</Text>
      </Row>
    );
  }
  if (variant === 'title') return <Text size="card-title" weight="bold" tone={color}>{text}</Text>;
  if (variant === 'caption') return <Text size="note" tone={tone ? color : 'secondary'}>{text}</Text>;
  return <Text size="body" tone={color}>{text}</Text>;
}

type FactItem = { label?: string; text: string; status?: 'reproduced' | 'passed' | 'failed' | 'info' };
const FACT_STATUS: Record<NonNullable<FactItem['status']>, { label: string; tone: BadgeTone } | null> = {
  reproduced: { label: '已复现', tone: 'neutral' },
  passed: { label: '通过', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  info: null,
};

// 事实列表画在 packages/components 的 FactList 里；这里把卡片里的 status 换成状态标签。
function FactListView({ items }: { items: readonly FactItem[] }) {
  return (
    <FactList
      items={items.map((item) => {
        const status = item.status ? FACT_STATUS[item.status] : null;
        return { label: item.label, value: item.text, ...(status ? { badge: status } : {}) };
      })}
    />
  );
}

// 紧凑的工单头：编号、标题、现在的状态，右边一个箭头，点开工单线程（和会话里的工单卡同一套样式）。
// 用户欠着决定时状态标签变成琥珀色，不换另一套说法（useTicketRef）。
function TicketHead({ ticketId }: { ticketId: number }) {
  const ref = useTicketRef(ticketId);
  return (
    <Pressable
      testID={`surface-ticket-${ticketId}`}
      aria-label={ref.label}
      onPress={ref.open}
      feedback="highlight"
      rounded="md"
      minH={36}
      justify="center"
    >
      <Row items="center" gap="inline-item" minW={0}>
        <Text size="meta" mono tone="secondary" shrink={0}>{`#${ticketId}`}</Text>
        <Text flex={1} minW={0} size="card-title" weight="semibold" numberOfLines={1}>{ref.title}</Text>
        {ref.status ? <Badge label={ref.status} tone={ref.needs ? 'warning' : 'neutral'} /> : null}
        <Box w={24} h={24} rounded="full" bg="surface-muted" items="center" justify="center" shrink={0}>
          <Icon name="chevron-right" size={11} color="text-secondary" weight="semibold" />
        </Box>
      </Row>
    </Pressable>
  );
}

// 引用的原文（2026-10-19）：服务端从工单正文或 checkpoint 里取出来的原话，照原样显示，上面写出处，点出处打开工单。
// Lead 转述时编造过文件路径，所以转述改成引用：这里没有一个字是 Lead 打的。
// 生成中（还没定稿）没有 text：只写「正在取原文…」。
function SourceQuote({ ticketId, text, label, truncated }: { ticketId: number; text: string | null; label: string | null; truncated: boolean }) {
  const openTicket = useOpenTicket();
  return (
    <Column testID={`surface-source-quote-${ticketId}`} gap="card-row" pl="inset-x" borderLeftWidth={3} borderColor="border-strong">
      <Pressable
        aria-label={`打开工单 #${ticketId}`}
        onPress={() => openTicket(ticketId)}
        feedback="highlight"
        rounded="sm"
        self="flex-start"
      >
        <Text size="meta" tone="secondary">{label ? `原文 · ${label}` : `原文 · 工单 #${ticketId}`}</Text>
      </Pressable>
      <Text size="body">{text ?? '正在取原文…'}</Text>
      {truncated ? <Text size="note" tone="secondary">只显示了开头，全文在工单里。</Text> : null}
    </Column>
  );
}

type ChoiceGroupProps = {
  ticket: number;
  prompt?: string;
  choices: Array<{ id: string; label: string; consequence?: string }>;
  recommendation?: { choiceId: string; reason: string };
  decision?: number;
};

// 请用户做决定：Lead 的建议在上，选项在下（推荐的选项高亮）。选项走现有的决策请求接口，授权照常；
// 决定的状态从决策请求实时读取：选完以后只写「你选了…」，不再给按钮。
// 选项卡片画在 packages/components 的 ChoiceGroup 里；这里读决策请求、提交选择。
function DecisionChoices({ ticket, prompt, choices, recommendation, decision, partial }: ChoiceGroupProps & { partial: boolean }) {
  const runtime = useCompanionRuntime();
  const connected = useConnectionState() === 'connected';
  const { interventions } = useTicketInterventions(ticket);
  const interventionId = decision ? `decision:${decision}` : null;
  const intervention = interventionId ? interventions.find((item) => item.id === interventionId) : undefined;
  const command = useWorkspaceStore((state) => interventionId ? state.interventionCommandStateById[interventionId] : undefined);
  const resolution = intervention && 'resolution' in intervention && intervention.kind !== 'approval' ? intervention.resolution : null;
  const chosen = resolution?.kind === 'option'
    ? choices.find((choice) => choice.id === resolution.optionId)?.label ?? resolution.optionId
    : null;
  const closed = intervention !== undefined && intervention.state !== 'pending';
  const submitting = command?.state === 'pending';
  const choose = (optionId: string) => {
    if (!interventionId) return;
    void runtime.resolveIntervention(interventionId, { authority: 'decision_request', decision: 'select', optionId }).catch(() => {});
  };
  return (
    <Column gap="card-row">
      {prompt ? <Text size="card-title" weight="semibold">{prompt}</Text> : null}
      {recommendation ? (
        <Column gap="text-stack" px="inset-x" py="inset-y" rounded="lg" bg="accent-wash">
          <Text size="label" weight="bold" tone="accent">我的建议</Text>
          <Text size="body">{recommendation.reason}</Text>
        </Column>
      ) : null}
      {closed ? (
        <Text size="label" weight="semibold" tone="secondary">
          {chosen ? `你选了「${chosen}」` : intervention?.state === 'expired' ? '这个决定已过期' : '这个决定已经处理'}
        </Text>
      ) : (
        <ChoiceGroup
          options={choices.map((choice) => ({ id: choice.id, label: choice.label, description: choice.consequence }))}
          recommended={recommendation?.choiceId}
          onSelect={choose}
          disabled={partial || !connected || submitting || !interventionId}
          optionTestID={(id) => `surface-choice-${id}`}
        />
      )}
      {command?.state === 'error' ? <Text size="note" tone="danger-dark">{command.error ?? '没能提交这个选择'}</Text> : null}
    </Column>
  );
}
