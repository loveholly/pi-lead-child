import {
  Box, Column, Flash, FloatingButton, FloatingSheet, Icon, Popover, Pressable, Row, Text, useBreakpoint,
  type ColorToken, type IconName, type TextTone,
} from '@pi-lead-child/components';
import { useMemo, useState, type ReactNode } from 'react';

import { MarkdownMessage } from '@/features/chat/MarkdownMessage';
import { useMessages } from '@/i18n';

import { ticketDetailLayoutMessages } from './ticketDetailLayout.messages';

// 工单详情的新版式（主题 11.21，画布第 71 版：桌面 ThreeCol*、手机 M3*，2026-11-14）。
// 内容平铺在白底上，分区之间一条细线；只有决定卡是悬浮的。层次靠字号和颜色：标题 24/32，分区标题 16/24，正文 14/24 用 text-strong。

// ── 顶栏 ──
// 手机：左边返回圆钮，右边「⋯」圆钮；在页面顶部时中间是空的（工单号不好记），滚过大标题以后中间出现标题，下面一条细线。
// 桌面：高 48，左边面包屑「项目 › 工单 #N」，右边「⋯」和关闭，下面一条细线。
// flash：变成一个新的值时顶栏闪一下（主题 Q-9b）：详情已经开着这张工单，你又点了打开它的入口（#590）。
// 只在桌面：手机上详情盖住会话，打开它的入口这时看不到。
export function DetailTopBar({ phone, project, displayId, title, scrolled, more, onBack, onClose, closeLabel, flash = null }: {
  phone: boolean;
  project: string | null;
  displayId: string;
  title: string;
  scrolled: boolean;
  more: ReactNode;
  onBack: () => void;
  onClose?: () => void;
  closeLabel: string;
  flash?: number | null;
}) {
  const m = useMessages(ticketDetailLayoutMessages);
  if (phone) {
    return (
      <Row testID="ticket-thread-header" items="center" gap="inline-item" px="page-x" py="float-row-y" position="relative"
        borderBottomWidth={scrolled ? 1 : 0} borderBottomColor="border-soft">
        <FloatingButton testID="ticket-thread-header-close" label={m.back} onPress={onBack}>
          <Icon name="chevron-left" size={20} color="text" weight="semibold" />
        </FloatingButton>
        <Box position="absolute" l={0} r={0} t={0} b={0} items="center" justify="center" px="page-title-gutter" pointerEvents="none" opacity={scrolled ? 1 : 0}>
          <Text size="card-title" weight="semibold" numberOfLines={1}>{title}</Text>
        </Box>
        <Box flex={1} />
        {more}
      </Row>
    );
  }
  return (
    <Row testID="ticket-thread-header" items="center" px="page-x" minH={48} borderBottomWidth={1} borderBottomColor="border-soft"
      position="relative">
      <Flash signal={flash} testID="ticket-thread-header-flash" />
      {/* 内容画在闪的底上面（Flash 的说明）。 */}
      <Row flex={1} minW={0} items="center" gap="inline-item" position="relative">
        <Text flex={1} minW={0} size="secondary" tone="secondary" numberOfLines={1}>{m.breadcrumb(project, displayId)}</Text>
        {more}
        {onClose ? (
          <Pressable testID="ticket-thread-header-close" aria-label={closeLabel} onPress={onClose} rounded="sm" p="pill-x" feedback="highlight">
            <Icon name="close" size={16} color="text-secondary" />
          </Pressable>
        ) : null}
      </Row>
    </Row>
  );
}

// 手机上「⋯」是一颗悬浮圆钮；桌面上是一个小图标。里面的菜单由调用方给（HeaderMenu 的 Popover）。
export function MoreTrigger({ phone }: { phone: boolean }) {
  if (phone) {
    return (
      <Box w={48} h={48} rounded="full" bg="surface" items="center" justify="center" boxShadow="0 4px 16px rgba(16,19,26,0.08), 0 1px 2px rgba(16,19,26,0.04)">
        <Icon name="more" size={20} color="text" />
      </Box>
    );
  }
  return <Row testID="ticket-header-more-trigger" p="pill-x"><Icon name="more" size={16} color="text-secondary" /></Row>;
}

// ── 标题 ──
// 可以换行，不截断。手机上下面一行写「工单 #N · 谁创建 · 时间」；桌面上同一行小字不带工单号（面包屑里有）。
export function DetailTitle({ title, meta }: { title: string; meta: string | null }) {
  return (
    <Column testID="ticket-detail-title" gap="text-stack">
      <Text testID="ticket-detail-title-text" size="page-title" weight="bold" role="heading">{title}</Text>
      {meta ? <Text testID="ticket-detail-meta" size="label" tone="muted">{meta}</Text> : null}
    </Column>
  );
}

// ── 分区 ──
// 上面一条 border-soft 细线和留白；标题 16/24、600，右边一行小字（出处、进度）。第一个分区不画线。
export function DetailSection({ title, count, aside, first = false, gap = 'card-row', children, testID }: {
  title: string;
  count?: number;
  aside?: ReactNode;
  first?: boolean;
  gap?: 'card-row' | 'text-stack' | 'field';
  children: ReactNode;
  testID?: string;
}) {
  return (
    <Column testID={testID} pt={first ? undefined : 'detail-section'} borderTopWidth={first ? 0 : 1} borderTopColor="border-soft" gap={gap}>
      <Row items="baseline" gap="inline-item">
        <Text size="sheet-title" weight="semibold" role="heading">{title}</Text>
        {count !== undefined ? <Text size="meta" mono tone="muted">{String(count)}</Text> : null}
        <Row flex={1} minW={0} justify="flex-end" items="center">{aside ?? null}</Row>
      </Row>
      {children}
    </Column>
  );
}

// ── 折叠行 ──
// 高 52，上面一条细线：分区标题、一句摘要（单行）、箭头。点开在下面展开内容。
export function FoldRow({ title, summary, source, open, onToggle, children, testID }: {
  title: string;
  summary?: ReactNode;
  // 出处（谁写的、系统记录）：展开时写在标题行右边；收着时那里是摘要。
  source?: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
  testID?: string;
}) {
  return (
    <Column testID={testID} borderTopWidth={1} borderTopColor="border-soft">
      <Pressable testID={testID ? `${testID}-toggle` : undefined} aria-expanded={open} onPress={() => onToggle(!open)} feedback="none" minH={52} justify="center">
        <Row items="center" gap="inline-item">
          <Text size="sheet-title" weight="semibold">{title}</Text>
          <Row flex={1} minW={0} justify={open ? 'flex-end' : 'flex-start'}>
            {open ? (source ? <Text size="label" tone="muted" numberOfLines={1}>{source}</Text> : null) : summary == null ? null : typeof summary === 'string'
              ? <Text size="body" tone="secondary" numberOfLines={1}>{summary}</Text>
              : summary}
          </Row>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color="text-secondary" />
        </Row>
      </Pressable>
      {open ? <Column pb="detail-section" gap="card-row">{children}</Column> : null}
    </Column>
  );
}

// ── 属性 ──
// 两列的小表：标签 12、muted、宽 44；值 13。Token 那一行占一整行。
export type AttributeItem = { key: string; label: string; value: string; tone?: TextTone; icon?: { name: IconName; color: ColorToken }; mono?: boolean };

export function DetailAttributes({ items, token }: { items: readonly AttributeItem[]; token?: ReactNode }) {
  const m = useMessages(ticketDetailLayoutMessages);
  return (
    <Row testID="ticket-attributes" aria-label={m.attributes} flexWrap="wrap">
      {items.map((item) => (
        <Row key={item.key} testID={`ticket-attribute-${item.key}`} w="47%" grow={1} minH={28} items="center" gap="inline-item">
          <Text w={44} size="label" tone="muted">{item.label}</Text>
          <Row flex={1} minW={0} items="center" gap="icon-label">
            {item.icon ? <Icon name={item.icon.name} size={14} color={item.icon.color} /> : null}
            {/* 英文的状态名长（Waiting for your acceptance）：最多折成两行，不截断。 */}
            <Text size="body" weight={item.tone ? 'semibold' : 'regular'} tone={item.tone ?? 'default'} mono={item.mono} numberOfLines={2}>{item.value}</Text>
          </Row>
        </Row>
      ))}
      {token ? <Row w="100%" minH={28} items="center" gap="inline-item">{token}</Row> : null}
    </Row>
  );
}

// Token 一行：「缓存 X 86% · 未缓存 Y」加一个信息图标；点图标打开四段明细（桌面是锚定浮层，手机是悬浮面板的小档）。
export type TokenPart = { key: string; label: string; value: string; weight: number; color: ColorToken };

// Token 一行（主题 T-8，画板 M3Token）：「缓存 X 86% · 未缓存 Y」，右边圆圈里的 i。没有缓存的拆分时（旧的用量）写总数。
// 点 i：手机上从底部升起贴合内容的悬浮面板，桌面上是 268 宽的浮层；里面是同一份明细。
export function TokenAttribute({ summary, total, parts, caption, onShowDetails }: {
  summary: { cached: string; uncached: string; percent: number } | null;
  total: string;
  parts: readonly TokenPart[];
  caption: string;
  // 手机上：点 i 时调用，页面在根上升起明细面板（TokenBreakdown）。
  // 面板不能画在滚动区里：Android 上滚动区里的 Modal 不出现（2026-11-15 真机）。不给时是桌面的浮层。
  onShowDetails?: () => void;
}) {
  const m = useMessages(ticketDetailLayoutMessages);
  const icon = <Icon name="info" size={14} color="text-muted" />;
  return (
    <>
      <Text w={44} size="label" tone="muted">{m.tokens}</Text>
      <Row flex={1} minW={0} items="center" gap="icon-label" flexWrap="wrap">
        {summary ? (
          <>
            <Text size="body">{m.cached('')}<Text size="secondary" mono>{summary.cached}</Text></Text>
            <Text size="secondary" tone="success-dark">{`${summary.percent}%`}</Text>
            <Text size="body" tone="muted">·</Text>
            <Text size="body">{m.uncached('')}<Text size="secondary" mono>{summary.uncached}</Text></Text>
          </>
        ) : <Text size="secondary" mono>{total}</Text>}
        {onShowDetails ? (
          // 点按区域比图标大：上下左右各多 10（组件规格）。
          <Pressable testID="ticket-token-details" aria-label={m.tokenDetails} onPress={onShowDetails} feedback="opacity" hitSlop={10}>
            {icon}
          </Pressable>
        ) : (
          <Popover testID="ticket-token-details" label={m.tokenDetails} title={m.tokenDetails} width={268} trigger={icon}>
            <TokenBreakdown total={total} parts={parts} caption={caption} heading={false} />
          </Popover>
        )}
      </Row>
    </>
  );
}

// 明细：标题和总数，一条按比例分段的条，每部分一行（色块、名字、数），最后一行说明（画板 M3Token）。
export function TokenBreakdown({ total, parts, caption, heading }: { total: string; parts: readonly TokenPart[]; caption: string; heading: boolean }) {
  const m = useMessages(ticketDetailLayoutMessages);
  const shown = parts.filter((part) => part.weight > 0);
  return (
    <Column testID="ticket-token-breakdown" gap="card-row">
      <Row items="baseline" gap="inline-item">
        {heading ? <Text flex={1} size="sheet-title" weight="bold">{m.tokenDetails}</Text> : <Text flex={1} size="label" tone="muted">{m.total}</Text>}
        <Text size="secondary" mono>{total}</Text>
      </Row>
      {shown.length > 0 ? (
        // spacing-exempt: 组件规格，分段条高 6，段之间 2（画板 M3Token）
        <Row h={6} gap={2} aria-hidden>
          {shown.map((part) => <Box key={part.key} flex={part.weight} rounded="full" bg={part.color} />)}
        </Row>
      ) : null}
      <Column testID="ticket-usage-parts">
        {parts.map((part) => (
          <Row key={part.key} minH={36} items="center" gap="side-item">
            <Box w={8} h={8} rounded="xs" bg={part.color} />
            <Text flex={1} size="body" tone="secondary">{part.label}</Text>
            <Text size="secondary" mono>{part.value}</Text>
          </Row>
        ))}
      </Column>
      <Box borderTopWidth={1} borderTopColor="border-soft" pt="card-row">
        <Text size="note" tone="secondary">{caption}</Text>
      </Box>
    </Column>
  );
}

// ── 读取中的占位 ──
// 还没读到的块先画同样高的灰条（patterns P1.5）：数据到了换成内容，页面不往下推（2026-11-15 用户：从会话的工单卡打开详情，
// 页面会重排）。行高是各块自己的规格：任务说明的正文 24、执行计划一步 28、关联工单一行 30。
export function PlaceholderLines({ lines, lineHeight, testID }: { lines: number; lineHeight: number; testID?: string }) {
  return (
    <Column testID={testID} aria-hidden>
      {Array.from({ length: lines }, (_, index) => (
        <Box key={index} h={lineHeight} justify="center">
          {/* 组件规格：灰条高 10，最后一行短一些 */}
          <Box h={10} w={index === lines - 1 && lines > 1 ? '60%' : '100%'} rounded="xs" bg="surface-muted" />
        </Box>
      ))}
    </Column>
  );
}

// ── 任务说明 ──
// 收着的任务说明只画到这么多字或者这么多行，够填满 6 行（144）：超出的部分本来就被截掉。
const BRIEF_PREVIEW_CHARS = 480;
const BRIEF_PREVIEW_LINES = 10;

/** 任务说明开头的一段，按整行截：不在一行中间切断 Markdown 的语法。 */
export function briefHead(markdown: string): string {
  const lines = markdown.split('\n');
  let length = 0;
  let count = 0;
  for (const line of lines) {
    if (count >= BRIEF_PREVIEW_LINES || (count > 0 && length + line.length > BRIEF_PREVIEW_CHARS)) break;
    length += line.length + 1;
    count += 1;
  }
  return count >= lines.length ? markdown : lines.slice(0, count).join('\n');
}

function briefChars(markdown: string): number {
  return markdown.replace(/\s+/g, '').length;
}

/** 手机上「展开全文」升起的面板里的内容。 */
export function TaskBriefSheetContent({ markdown, writer }: { markdown: string; writer: string }) {
  const m = useMessages(ticketDetailLayoutMessages);
  return (
    <Column gap="card-row">
      <Text size="label" weight="semibold" tone="secondary">{m.fullTaskTitle(writer, briefChars(markdown))}</Text>
      <MarkdownMessage markdown={markdown} tone="strong" />
    </Column>
  );
}

// 最多 6 行（最高 144），超出截掉、底部渐隐，下面「展开全文 · 约 N 字」。桌面原地展开；手机升起高档的面板看全文。
const BRIEF_MAX_HEIGHT = 144; // 组件规格：6 行 × 24

export function TaskBrief({ markdown, onExpandInline, onOpenSheet, expanded }: {
  markdown: string;
  expanded: boolean;
  onExpandInline: (open: boolean) => void;
  // 手机上「展开全文」：页面在根上升起高的面板（TaskBriefSheetContent）。面板不画在滚动区里，见 TokenAttribute。
  onOpenSheet: () => void;
}) {
  const m = useMessages(ticketDetailLayoutMessages);
  const { tablet } = useBreakpoint();
  const [measuredOverflow, setOverflows] = useState(false);
  const chars = briefChars(markdown);
  // 收着时只画开头够 6 行的那一段（2026-11-15 真机测量：整篇 2,300 字的 Markdown 占了打开详情页首次渲染的 178/275ms，
  // 画出来又被截掉）。展开或者在面板里才画全文。
  const preview = useMemo(() => briefHead(markdown), [markdown]);
  const overflows = measuredOverflow || preview.length < markdown.length;
  const open = () => (tablet ? onExpandInline(true) : onOpenSheet());
  return (
    <Column gap="card-row">
      <Box position="relative" maxH={expanded ? undefined : BRIEF_MAX_HEIGHT} overflow="hidden">
        <Box onLayout={(event) => setOverflows(event.nativeEvent.layout.height > BRIEF_MAX_HEIGHT + 1)}>
          <MarkdownMessage markdown={expanded ? markdown : preview} tone="strong" />
        </Box>
        {!expanded && overflows ? (
          // 渐隐：三条越来越实的白底叠出来（三端都能画，不用渐变）。
          <Column position="absolute" l={0} r={0} b={0} pointerEvents="none">
            <Box h={12} bg="surface" opacity={0.35} />
            <Box h={12} bg="surface" opacity={0.7} />
            <Box h={12} bg="surface" opacity={0.95} />
          </Column>
        ) : null}
      </Box>
      {overflows || expanded ? (
        <Pressable testID="ticket-brief-toggle" onPress={expanded ? () => onExpandInline(false) : open} self="flex-start" feedback="opacity">
          <Text size="body" weight="semibold" tone="accent">{expanded ? m.fullTask : m.showAll(chars)}</Text>
        </Pressable>
      ) : null}
    </Column>
  );
}

// ── 关联工单 ──
// 子工单和别的关联在同一个列表里（用户定的），按状态分组，要你管的在最前：等你、在执行、排队；已完成收成一行，点开才列出。
// 每行：最左边是关系（子工单是 ↳ 图标，其他写字），状态图标，工单号（等宽），标题（单行截断），状态词。行和行之间没有线。
export type RelationRowItem = {
  key: string;
  testID: string;
  ticketId: string;
  title: string;
  relation: string | null; // null：子工单（画 ↳）
  state: 'waiting' | 'running' | 'queued' | 'done' | 'cancelled' | null; // null：关联的工单不知道状态
  stateLabel: string | null;
  detail?: string | null;
  onPress?: () => void;
  action?: ReactNode;
};

const STATE_ICON: Record<NonNullable<RelationRowItem['state']>, { name: IconName; color: ColorToken }> = {
  waiting: { name: 'circle-fill', color: 'warning' },
  running: { name: 'progress', color: 'accent' },
  queued: { name: 'circle-fill', color: 'border-strong' },
  done: { name: 'check', color: 'success' },
  cancelled: { name: 'close', color: 'text-muted' },
};
const STATE_TONE: Record<NonNullable<RelationRowItem['state']>, TextTone> = {
  waiting: 'warning-dark', running: 'accent', queued: 'secondary', done: 'success-dark', cancelled: 'muted',
};

export function RelationRows({ items, childDone, childTotal, segments, footer }: {
  items: readonly RelationRowItem[];
  childDone: number;
  childTotal: number;
  segments: readonly ('done' | 'running' | 'waiting' | 'queued')[];
  footer?: ReactNode;
}) {
  const m = useMessages(ticketDetailLayoutMessages);
  const [doneOpen, setDoneOpen] = useState(false);
  const groups: { key: string; label: string; tone: TextTone; rows: RelationRowItem[] }[] = [
    { key: 'waiting', label: m.groupWaiting, tone: 'warning-dark', rows: items.filter((item) => item.state === 'waiting') },
    { key: 'running', label: m.groupRunning, tone: 'strong', rows: items.filter((item) => item.state === 'running') },
    { key: 'queued', label: m.groupQueued, tone: 'strong', rows: items.filter((item) => item.state === 'queued') },
    { key: 'links', label: m.groupLinks, tone: 'strong', rows: items.filter((item) => item.state === null) },
  ];
  const done = items.filter((item) => item.state === 'done' || item.state === 'cancelled');
  return (
    <Column gap="text-stack">
      {childTotal > 0 ? (
        <Row testID="ticket-child-progress" role="img" aria-label={m.childProgressLabel(childDone, childTotal)} gap="text-stack" pb="text-stack">
          {segments.map((segment, index) => (
            <Box key={index} flex={1} h={6} rounded="full" // 组件规格：每段高 6
              bg={segment === 'done' ? 'success' : segment === 'running' ? 'accent' : segment === 'waiting' ? 'warning' : 'border-strong'} />
          ))}
        </Row>
      ) : null}
      {groups.filter((group) => group.rows.length).map((group) => (
        <Column key={group.key} testID={`ticket-relations-${group.key}`}>
          <Row items="center" gap="icon-label" minH={20}>
            <Text size="label" weight="semibold" tone={group.tone}>{group.label}</Text>
            <Text size="meta" mono tone="muted">{String(group.rows.length)}</Text>
          </Row>
          {group.rows.map((row) => <RelationRow key={row.key} row={row} />)}
        </Column>
      ))}
      {done.length ? (
        <Column borderTopWidth={1} borderTopColor="border-soft">
          <Pressable testID="ticket-relations-done" aria-expanded={doneOpen} onPress={() => setDoneOpen(!doneOpen)} feedback="none" minH={32} justify="center">
            <Row items="center" gap="inline-item">
              <Icon name="check" size={14} color="success" />
              <Text size="label" weight="semibold" tone="strong">{m.done}</Text>
              <Text size="meta" mono tone="muted">{String(done.length)}</Text>
              <Text flex={1} minW={0} size="label" tone="muted" align="right" numberOfLines={1}>{m.latest(`#${done[0]!.ticketId}`)}</Text>
              <Icon name={doneOpen ? 'chevron-up' : 'chevron-down'} size={14} color="text-secondary" />
            </Row>
          </Pressable>
          {doneOpen ? done.map((row) => <RelationRow key={row.key} row={row} />) : null}
        </Column>
      ) : null}
      {footer ?? null}
    </Column>
  );
}

function RelationRow({ row }: { row: RelationRowItem }) {
  const m = useMessages(ticketDetailLayoutMessages);
  const icon = row.state ? STATE_ICON[row.state] : null;
  return (
    <Pressable testID={row.testID} onPress={row.onPress} disabled={!row.onPress} feedback="highlight" minH={30} justify="center"
      aria-label={[row.relation ?? m.child, `#${row.ticketId}`, row.title, row.stateLabel].filter(Boolean).join(' ')}>
      <Row items="center" gap="icon-label">
        <Box w={34} shrink={0}>
          {row.relation === null
            ? <Icon name="reply" size={14} color="text-secondary" />
            : <Text size="meta" tone="secondary" numberOfLines={1}>{row.relation}</Text>}
        </Box>
        {icon ? <Icon name={icon.name} size={12} color={icon.color} /> : null}
        <Text flex={1} minW={0} size="card-title" weight="regular" numberOfLines={1}>
          <Text size="meta" mono tone="muted">{`#${row.ticketId} `}</Text>
          {row.title}
        </Text>
        {row.stateLabel ? <Text size="label" weight="semibold" tone={row.state ? STATE_TONE[row.state] : 'secondary'}>{row.stateLabel}</Text> : null}
        {row.action ?? null}
      </Row>
    </Pressable>
  );
}
