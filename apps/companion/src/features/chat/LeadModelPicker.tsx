import {
  Badge, Box, Button, Column, elevation, FloatingSheet, Icon, PopoverAnchorView, PopoverPanel, Pressable, ProgressBar, Row, ScrollArea,
  Spacer, Text, TextField, useBreakpoint, type PopoverAnchor, type PopoverAnchorHandle,
} from '@pi-lead-child/components';
import {
  CHAT_TURN_MODEL_CAPABILITY, parseLeadModelSpec, subscriptionAccountOf, subscriptionSlotSpec,
  type LeadModelCatalog, type LeadModelChoice, type LeadModelOption,
} from '@pi-lead-child/protocol';
import { useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { useLocale, useMessages, type Locale } from '@/i18n';
import { useCompanionRuntime, useControlPlaneStore } from '@/state/CompanionStateProvider';
import { useLeadBusy, useLeadName, useModelSettings } from '@/state/hooks';

import { leadModelMessages, SUBSCRIPTION_NAMES } from './leadModel.messages';
import {
  accountInSession, chainRole, connectionKeyOf, contextWindows, formatContextWindow, leadModelConnections, leadModelLabel,
  matchesLeadModel, pinnedAccountOf, sameSlot, withAccount, type PickerAccount, type PickerConnection,
} from './leadModelGroups';

// 会话里换模型（模型配置方案 C 的 S4、S5，画板 C-Picker-Desktop / C-Picker-Mobile，用户 2026-11-16 定）。
// 入口：桌面上输入框工具栏右边的模型名（LeadModelComposerTrigger）；手机上加号面板里的「模型」一行；两边都能在输入框里输入 /model。
// 桌面上是锚定的浮层（PopoverPanel，P2），手机上是悬浮底部面板（FloatingSheet，P13.2）。打开浮层不改变会话列表（P1）。
//   · 头：正在用的模型，下面一行「接入 · 账号 · 正在用」（账号按会话此刻挂着的模型，inSession）；搜索全部模型。
//   · 左栏（桌面）：接入，分「订阅」和「API key」两组；订阅带 5 小时额度的小条，API key 写模型数。手机上是能收起的一段一段。
//   · 右边：订阅的「账号」（缺省自动；选一个账号就固定它：分工写 <base>-<n>/<id>），然后是这个接入的模型，主用、备用有标记。
//   · 底部：左边是选着的模型的推理强度菜单「推理 · 现在的强度」（EffortMenu，视觉稿方案 C，用户 2026-11-24 定），
//     右边「只这一条」（下一条消息用它答一次，daemon 宣布了 chat.turn-model.v1 才有）和「换成主用」（主按钮，改分工的第一个）。
//     两种用法都带着菜单里选的强度。
// 「换成主用」和 Lead 的 switch_lead_model 是同一个操作：Lead 空闲时马上换，正在回答时这一轮结束后换。

// 组件规格：桌面浮层宽 580，左栏 196，下面两栏高 344（画板 C-Picker-Desktop）。一个接入先列 8 个模型，其余点「再显示」。
const PANEL_WIDTH = 580;
const CONNECTIONS_WIDTH = 196;
const COLUMNS_HEIGHT = 344;
const PANEL_MAX_HEIGHT = 560;
const FIRST_MODELS = 8;
// 组件规格：额度小条宽 36、高 3（画板）。
const QUOTA_BAR_WIDTH = 36;
const QUOTA_BAR_HEIGHT = 3;

type CatalogState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; catalog: LeadModelCatalog };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type LeadModelPickerProps = {
  open: boolean;
  // 桌面上浮层对着的位置（触发它的模型名，或者输入框）。手机上不用。
  anchor: PopoverAnchor | null;
  onClose: () => void;
  // 「只这一条」：给了才有这个按钮（daemon 也要宣布 chat.turn-model.v1）。
  onTurnModel?: (choice: LeadModelChoice) => void;
  // 「换成主用」做成以后（例如「换个模型重发」接着重发）。
  onSwitched?: () => void;
  testID?: string;
};

// 浮层本身。关着时不读目录；关上以后等收起的动画播完再卸载里面的内容。
export function LeadModelPicker(props: LeadModelPickerProps) {
  const [live, setLive] = useState(props.open);
  if (props.open && !live) setLive(true);
  useEffect(() => {
    if (props.open || !live) return undefined;
    const timer = setTimeout(() => setLive(false), 300);
    return () => clearTimeout(timer);
  }, [props.open, live]);
  if (!live) return null;
  return <LeadModelPickerBody {...props} />;
}

function LeadModelPickerBody({ open, anchor, onClose, onTurnModel, onSwitched, testID = 'lead-model-picker' }: LeadModelPickerProps) {
  const locale = useLocale();
  const m = leadModelMessages(locale);
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const busy = useLeadBusy();
  const breakpoint = useBreakpoint();
  const sheet = !breakpoint.tablet;
  const { modelSettings } = useModelSettings();
  const turnModelSupported = useControlPlaneStore((state) => state.capabilities.includes(CHAT_TURN_MODEL_CAPABILITY));
  const [state, setState] = useState<CatalogState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<LeadModelChoice | null>(null);
  const [connectionKey, setConnectionKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [switching, setSwitching] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'secondary' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    let current = true;
    runtime.loadLeadModels().then(
      (catalog) => {
        if (!current) return;
        setState({ status: 'ready', catalog });
        // 打开时选着的是分工的主用：「只这一条」要先点一个别的模型。
        setDraft((value) => value ?? catalog.selected);
        setConnectionKey((value) => value ?? connectionKeyOf(catalog.selected.model));
      },
      (error: unknown) => { if (current) setState({ status: 'error', message: errorText(error) }); },
    );
    return () => { current = false; };
  }, [open, runtime, attempt]);

  const catalog = state.status === 'ready' ? state.catalog : null;
  const connections = useMemo(
    () => (catalog ? leadModelConnections(catalog.models, modelSettings?.subscriptions) : []),
    [catalog, modelSettings?.subscriptions],
  );
  const windows = useMemo(() => contextWindows(modelSettings), [modelSettings]);
  const chain = modelSettings?.brain.chain ?? (catalog ? [catalog.selected] : []);
  const inSession = catalog?.inSession ?? catalog?.current.model ?? null;
  const inUse = catalog ? (catalog.inSession ? { model: catalog.inSession, effort: catalog.current.effort } : catalog.current) : null;
  const draftOption = catalog && draft ? catalog.models.find((model) => sameSlot(model.model, draft.model)) ?? null : null;
  const selectedConnection = connections.find((entry) => entry.key === connectionKey) ?? connections[0] ?? null;

  const pick = (model: LeadModelOption, connection: PickerConnection) => {
    // 订阅固定了账号时，换模型也留在这个账号上。
    const account = draft && connectionKeyOf(draft.model) === connection.key ? pinnedAccountOf(draft.model) : null;
    const effort = draft?.effort && model.efforts.includes(draft.effort) ? draft.effort : null;
    setDraft({ model: withAccount(model.model, account), effort });
    setEffortOpen(false);
    setNotice(null);
  };
  const setAccount = (connection: PickerConnection, account: string | null) => {
    const base = draft && connectionKeyOf(draft.model) === connection.key ? draft : null;
    const model = base?.model ?? connection.models[0]?.model;
    if (!model) return;
    setDraft({ model: withAccount(model, account), effort: base?.effort ?? null });
    setEffortOpen(false);
    setNotice(null);
  };

  // 和正在用的一样：同一个模型和推理强度。选的是「自动」时，同一格的任何账号都算一样。
  const sameAsInUse = Boolean(draft && inUse && draft.effort === inUse.effort
    && (draft.model === inUse.model || (pinnedAccountOf(draft.model) === null && sameSlot(draft.model, inUse.model))));
  const sameAsPrimary = Boolean(draft && catalog && draft.model === catalog.selected.model && draft.effort === catalog.selected.effort);
  const onlyThis = turnModelSupported && onTurnModel ? () => {
    if (!draft) return;
    onTurnModel(draft);
    onClose();
  } : null;
  const makePrimary = () => {
    if (!draft || switching) return;
    setSwitching(true);
    setNotice(null);
    runtime.switchLeadModel(draft).then(
      (result) => {
        setSwitching(false);
        if (result.applied === 'after_turn' && !onSwitched) {
          setState((value) => (value.status === 'ready' ? { status: 'ready', catalog: { ...value.catalog, selected: result.selected } } : value));
          setNotice({ tone: 'secondary', text: m.afterTurnSwitched(modelName(draft.model, catalog, locale)) });
          return;
        }
        onClose();
        onSwitched?.();
      },
      (error: unknown) => {
        setSwitching(false);
        setNotice({ tone: 'danger', text: errorText(error) });
      },
    );
  };

  const header = (
    <PickerHeader
      sheet={sheet}
      catalog={catalog}
      inUse={inUse}
      inSession={inSession}
      connections={connections}
      search={search}
      onSearch={setSearch}
    />
  );
  // 选着的模型能选的推理强度。不能选时没有菜单。
  const efforts = draftOption?.efforts ?? [];
  const footer = (
    <PickerFooter
      sheet={sheet}
      effortMenu={draft && efforts.length ? (
        <EffortMenu
          sheet={sheet}
          efforts={efforts}
          value={draft.effort}
          open={effortOpen}
          onToggle={() => setEffortOpen((value) => !value)}
          onClose={() => setEffortOpen(false)}
          onPick={(effort) => { setDraft({ ...draft, effort }); setEffortOpen(false); setNotice(null); }}
        />
      ) : null}
      notice={notice?.text ?? (busy ? m.afterTurn : null)}
      noticeTone={notice?.tone ?? 'secondary'}
      onlyThis={onlyThis}
      onlyThisDisabled={!draft || sameAsInUse || switching}
      makePrimaryDisabled={!draft || sameAsPrimary || switching}
      switching={switching}
      onMakePrimary={makePrimary}
    />
  );

  let body: ReactNode;
  if (state.status === 'loading') {
    body = <Box p="card"><Text testID="lead-model-loading" size="note" tone="muted">{m.loading}</Text></Box>;
  } else if (state.status === 'error') {
    body = (
      <Column p="card" gap="card-row">
        <Text testID="lead-model-error" size="note" tone="danger">{m.loadFailed(state.message)}</Text>
        <Row><Button label={m.retry} size="sm" variant="outline" onPress={() => { setState({ status: 'loading' }); setAttempt((count) => count + 1); }} /></Row>
      </Column>
    );
  } else {
    const rows = {
      draft, chain, inSession, windows, locale,
      onPick: pick, onAccount: setAccount,
      expanded, onExpand: (key: string) => setExpanded((value) => ({ ...value, [key]: true })),
    };
    body = search.trim() ? (
      <SearchResults connections={connections} query={search} rows={rows} sheet={sheet} />
    ) : sheet ? (
      <ConnectionSections connections={connections} open={selectedConnection?.key ?? null} onToggle={(key) => setConnectionKey((value) => (value === key ? null : key))} rows={rows} />
    ) : (
      <Row h={COLUMNS_HEIGHT} items="stretch">
        <Box w={CONNECTIONS_WIDTH} borderRightWidth={1} borderRightColor="border-soft">
          <ScrollArea nested testID="lead-model-connections">
            <ConnectionList connections={connections} selected={selectedConnection?.key ?? null} onSelect={setConnectionKey} inSession={inSession} />
          </ScrollArea>
        </Box>
        <Box flex={1} minW={0}>
          <ScrollArea nested testID="lead-model-models">
            {selectedConnection ? <ConnectionModels connection={selectedConnection} rows={rows} /> : null}
          </ScrollArea>
        </Box>
      </Row>
    );
  }

  const label = m.pickerTitle;
  if (sheet) {
    return (
      <FloatingSheet testID={testID} inset="menu" open={open} onClose={onClose} label={`${leadName} · ${label}`} footer={footer}>
        <Column testID={`${testID}-content`} gap="card-section">
          {header}
          {body}
        </Column>
      </FloatingSheet>
    );
  }
  return (
    <PopoverPanel
      testID={testID}
      anchor={open ? anchor : null}
      onClose={onClose}
      label={label}
      width={PANEL_WIDTH}
      maxHeight={PANEL_MAX_HEIGHT}
      header={header}
      footer={footer}
    >
      {body}
    </PopoverPanel>
  );
}

// 模型的显示名：目录给的名字，没有时是去掉账号前缀的 id。
function modelName(model: string, catalog: LeadModelCatalog | null, _locale: Locale): string {
  const option = catalog?.models.find((candidate) => sameSlot(candidate.model, model));
  if (option?.name) return option.name;
  return leadModelLabel(subscriptionSlotSpec(parseLeadModelSpec(model).model), option?.prefix ?? null).id;
}

function connectionName(key: string): string {
  return SUBSCRIPTION_NAMES[key] ?? key;
}

function accountName(account: Pick<PickerAccount, 'label' | 'index'>, locale: Locale): string {
  return account.label ?? leadModelMessages(locale).accountN(account.index);
}

function PickerHeader({ sheet, catalog, inUse, inSession, connections, search, onSearch }: {
  sheet: boolean;
  catalog: LeadModelCatalog | null;
  inUse: LeadModelChoice | null;
  inSession: string | null;
  connections: readonly PickerConnection[];
  search: string;
  onSearch: (value: string) => void;
}) {
  const locale = useLocale();
  const m = leadModelMessages(locale);
  const key = inUse ? connectionKeyOf(inUse.model) : null;
  const connection = connections.find((entry) => entry.key === key) ?? null;
  const index = key ? accountInSession(key, inSession) : null;
  const account = connection && index !== null ? connection.accounts.find((entry) => entry.index === index) ?? null : null;
  // magpie 的通道（route）：同名的模型走不同通道，写在接入后面才分得清正在用的是哪一个。
  const route = inUse ? catalog?.models.find((option) => sameSlot(option.model, inUse.model))?.route ?? null : null;
  const subtitle = key
    ? m.inUseLine([
      connectionName(key),
      ...(account && connection && connection.accounts.length > 1 ? [accountName(account, locale)] : []),
      ...(route ? [route] : []),
    ].join(' · '))
    : null;
  const title = (
    <Column minW={0} shrink={1} gap="text-stack">
      <Text testID="lead-model-in-use" size={sheet ? 'section-title' : 'card-title'} weight={sheet ? 'bold' : 'semibold'} numberOfLines={1}>
        {inUse ? `${modelName(inUse.model, catalog, locale)}${inUse.effort ? ` · ${m.effortName(inUse.effort)}` : ''}` : m.unknownModel}
      </Text>
      {subtitle ? <Text testID="lead-model-in-use-source" size="meta" tone="muted" numberOfLines={1}>{subtitle}</Text> : null}
    </Column>
  );
  return (
    <Column gap="card-section" {...(sheet ? {} : { px: 'card' as const, pt: 'card' as const, pb: 'inset-y' as const })}>
      {title}
      <TextField
        testID="lead-model-search"
        accessibilityLabel={m.searchLabel}
        value={search}
        onChangeText={onSearch}
        placeholder={m.searchPlaceholder}
        variant="filled"
        size="sm"
        autoCapitalize="none"
        autoCorrect={false}
      />
    </Column>
  );
}

function PickerFooter({ sheet, effortMenu, notice, noticeTone, onlyThis, onlyThisDisabled, makePrimaryDisabled, switching, onMakePrimary }: {
  sheet: boolean;
  effortMenu: ReactNode;
  notice: string | null;
  noticeTone: 'secondary' | 'danger';
  onlyThis: (() => void) | null;
  onlyThisDisabled: boolean;
  makePrimaryDisabled: boolean;
  switching: boolean;
  onMakePrimary: () => void;
}) {
  const m = useMessages(leadModelMessages);
  const size = sheet ? 'lg' as const : 'sm' as const;
  const only = onlyThis ? (
    <Button testID="lead-model-only-this" label={m.onlyThis} variant="outline" tone="neutral" size={size} fullWidth={sheet} disabled={onlyThisDisabled} onPress={onlyThis} />
  ) : null;
  const primary = (
    <Button testID="lead-model-make-primary" label={switching ? m.switching : m.makePrimary} variant="solid" tone="accent" size={size} fullWidth={sheet} disabled={makePrimaryDisabled} onPress={onMakePrimary} />
  );
  if (sheet) {
    // 手机：两颗按钮各占一半（P13.2b：最多一个主按钮和一个次按钮）。
    return (
      // FloatingSheet 的操作条是横排的一行：这一块占满它。
      <Column testID="lead-model-footer" flex={1} minW={0} gap="card-row">
        {notice ? <Text testID="lead-model-notice" size="note" tone={noticeTone}>{notice}</Text> : null}
        {effortMenu}
        <Row gap="actions">
          {only ? <Box flex={1}>{only}</Box> : null}
          <Box flex={1}>{primary}</Box>
        </Row>
      </Column>
    );
  }
  return (
    // 推理强度的选项是浮层（EffortMenu），不占这一行的高度：打开、收起时操作条一样高。
    <Row testID="lead-model-footer" items="center" gap="side-item" px="card" py="inset-y">
      {effortMenu}
      <Text testID="lead-model-notice" flex={1} minW={0} size="meta" tone={noticeTone} numberOfLines={2}>{notice ?? ''}</Text>
      <Row gap="actions" shrink={0}>{only}{primary}</Row>
    </Row>
  );
}

// 键盘也能用（P13.6）：组件库的 Pressable 在 web 上是 div role="button"，Tab 走不到它，Enter 和空格也不触发。
// 推理强度的选项是列表行（Pressable），自己补上：进 Tab 顺序，Enter 或空格等于点一下，键盘聚焦时一圈强调色的描边。
function keyboardPress(action: () => void) {
  return {
    tabIndex: 0,
    onKeyDown: (event: { key: string; preventDefault: () => void }) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
    },
    focusVisibleStyle: { outlineWidth: 2, outlineStyle: 'solid', outlineColor: 'accent' },
  } as const;
}

// 推理强度的菜单（视觉稿方案 C，用户 2026-11-24 定）：底部操作条的左边，和「只这一条」「换成主用」同一区，两种用法都带着它。
// 触发块和右边两颗按钮是同一个 Button（outline、neutral，桌面 sm、手机 lg）：一样高、一样的内边距、字号、字重和圆角
// （用户 2026-11-24：不要另写一套小号样式）。文字「推理 · 现在的强度」，后面一个箭头。web 上它是 <button>，Tab、Enter、空格都能用。
// 点开以后，选项是一块向上弹出的浮层：绝对定位在触发块上面，盖住模型列表，不占操作条的高度（用户 2026-11-24：展开时不能把
// 操作条撑高）。列出这个模型能发出去的强度，第一项「缺省」（不带强度，用服务商的缺省）。只有触发块用按钮的尺寸；选项是列表行：
// 文字靠左、常规字重，选中的一行 accent-wash 底、accent 字、行尾 check、aria-pressed（用户 2026-11-24）。
// 选了收起，焦点回到触发块。点浮层外面、按 Esc 只收起菜单，不关整个选择器（web）。同一个选择器里展开，不另开浮层（P2.8）。
// 组件规格：浮层最窄 180（选项文字「Extra high」加 check 的宽度）。
const EFFORT_OPTIONS_MIN_WIDTH = 180;

function EffortMenu({ sheet, efforts, value, open, onToggle, onClose, onPick }: {
  sheet: boolean;
  efforts: readonly string[];
  value: string | null;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onPick: (effort: string | null) => void;
}) {
  const m = useMessages(leadModelMessages);
  const container = useRef<ComponentRef<typeof Box>>(null);
  const current = value ? m.effortName(value) : m.defaultEffort;
  const options: Array<string | null> = [null, ...efforts];
  const focusTrigger = () => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    // Button 不给 ref：按 testID 找到 web 上的那颗 <button>。
    setTimeout(() => (document.querySelector('[data-testid="lead-model-effort-menu"]') as HTMLElement | null)?.focus(), 0);
  };
  const pick = (effort: string | null) => {
    onPick(effort);
    focusTrigger();
  };

  // web：菜单开着时，点它外面收起它（这一下照样作用在被点的东西上，P2.5）；Esc 只收起菜单。
  // 在捕获阶段先拿到 Esc 并停住：选择器的 Modal 在 document 上听 keyup，不然 Esc 会把整个选择器关掉。
  useEffect(() => {
    if (!open || Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    const inside = (target: EventTarget | null) => {
      const node = container.current as unknown as Node | null;
      return Boolean(node && target instanceof Node && node.contains(target));
    };
    const onPointerDown = (event: Event) => { if (!inside(event.target)) onClose(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (event.type === 'keyup') {
        onClose();
        focusTrigger();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, [open, onClose]);

  return (
    <Box ref={container} testID="lead-model-effort" position="relative" shrink={0} {...(sheet ? { self: 'flex-start' as const } : {})}>
      <Button
        testID="lead-model-effort-menu"
        label={m.effortMenu(current)}
        accessibilityLabel={m.effortMenuLabel(current)}
        variant="outline"
        tone="neutral"
        size={sheet ? 'lg' : 'sm'}
        icon={open ? 'chevron-up' : 'chevron-down'}
        iconPosition="end"
        onPress={onToggle}
      />
      {open ? (
        <Column
          testID="lead-model-effort-options"
          aria-label={m.effortOptions}
          position="absolute"
          b="100%"
          l={0}
          mb="nav-item"
          minW={EFFORT_OPTIONS_MIN_WIDTH}
          p="pill-y"
          gap="nav-item"
          rounded="md"
          borderWidth={1}
          borderColor="border-soft"
          bg="surface"
          boxShadow={elevation.raised}
        >
          {options.map((option) => {
            const chosen = option === value;
            const name = option ? m.effortName(option) : m.defaultEffort;
            // 列表的一行（不是按钮）：文字靠左、常规字重；选中的一行 accent-wash 底、accent 字、行尾 check（用户 2026-11-24）。
            return (
              <Pressable
                key={option ?? 'default'}
                testID={`lead-model-effort-${option ?? 'default'}`}
                aria-label={chosen ? m.selectedLabel(name) : name}
                aria-pressed={chosen}
                feedback="highlight"
                rounded="sm"
                px="inset-y"
                py={sheet ? 'row-y' : 'pill-y'}
                // 手机上每一行点得到的高度至少 44（P13.5，和 ChoiceGroup 的选项一样）。
                {...(sheet ? { minH: 44, justify: 'center' as const } : {})}
                bg={chosen ? 'accent-wash' : 'transparent'}
                onPress={() => pick(option)}
                {...keyboardPress(() => pick(option))}
              >
                <Row items="center" gap="inline-item">
                  <Text testID={`effort-option-text-${option ?? 'default'}`} flex={1} minW={0} size="label" weight="regular" tone={chosen ? 'accent' : 'default'} numberOfLines={1}>
                    {name}
                  </Text>
                  {chosen ? <Icon name="check" size={14} color="accent" accessibilityLabel={m.selected} /> : null}
                </Row>
              </Pressable>
            );
          })}
        </Column>
      ) : null}
    </Box>
  );
}

// 左栏：订阅一组、API key 一组。选中的一格浅灰底、文字用强调色，并且 aria-pressed（不只靠颜色，P7.2）。
function ConnectionList({ connections, selected, onSelect, inSession }: {
  connections: readonly PickerConnection[];
  selected: string | null;
  onSelect: (key: string) => void;
  inSession: string | null;
}) {
  const locale = useLocale();
  const m = leadModelMessages(locale);
  const groups = [
    { title: m.subscriptionsGroup, items: connections.filter((entry) => entry.kind === 'subscription') },
    { title: m.apiKeysGroup, items: connections.filter((entry) => entry.kind === 'key') },
  ].filter((group) => group.items.length);
  return (
    <Column testID="lead-model-connection-list" aria-label={m.connections} px="inset-y" py="inset-y" gap="nav-item">
      {groups.map((group) => (
        <Column key={group.title} gap="nav-item">
          <Text size="meta" weight="semibold" tone="faint" px="inset-y" pt="inset-y">{group.title}</Text>
          {group.items.map((connection) => {
            const quota = connectionQuota(connection, inSession);
            const active = connection.key === selected;
            return (
              <Pressable
                key={connection.key}
                testID={`lead-model-connection-${connection.key}`}
                aria-label={quota === null ? m.connectionLabel(connectionName(connection.key), connection.models.length)
                  : m.connectionQuotaLabel(connectionName(connection.key), quota)}
                aria-pressed={active}
                feedback="highlight"
                onPress={() => onSelect(connection.key)}
                rounded="md"
                px="inset-y"
                py="inset-y"
                bg={active ? 'surface-muted' : 'transparent'}
              >
                <Row items="center" gap="inline-item">
                  <Text flex={1} minW={0} size="label" weight={active ? 'semibold' : 'regular'} tone={active ? 'accent' : 'secondary'} numberOfLines={1}>
                    {connectionName(connection.key)}
                  </Text>
                  {quota === null ? (
                    <Text size="meta" tone="muted">{String(connection.models.length)}</Text>
                  ) : <QuotaMeter used={quota} />}
                </Row>
              </Pressable>
            );
          })}
        </Column>
      ))}
    </Column>
  );
}

// 订阅的额度：会话此刻在用的那个账号的 5 小时窗口，没在用时取第一个账号的。查不到时为 null。
function connectionQuota(connection: PickerConnection, inSession: string | null): number | null {
  if (connection.kind !== 'subscription' || !connection.quotaSupported) return null;
  const index = accountInSession(connection.key, inSession);
  const account = connection.accounts.find((entry) => entry.index === index) ?? connection.accounts[0];
  return account?.quotaUsed ?? null;
}

function QuotaMeter({ used }: { used: number }) {
  return (
    <Row items="center" gap="icon-label" shrink={0}>
      <Box w={QUOTA_BAR_WIDTH}><ProgressBar value={used} color="accent" track="surface-muted" height={QUOTA_BAR_HEIGHT} /></Box>
      <Text size="meta" tone="muted" mono>{`${used}%`}</Text>
    </Row>
  );
}

type RowsContext = {
  draft: LeadModelChoice | null;
  chain: readonly LeadModelChoice[];
  inSession: string | null;
  windows: ReadonlyMap<string, number>;
  locale: Locale;
  onPick: (model: LeadModelOption, connection: PickerConnection) => void;
  onAccount: (connection: PickerConnection, account: string | null) => void;
  expanded: Record<string, boolean>;
  onExpand: (key: string) => void;
};

// 右边：订阅的账号，然后是这个接入的模型。
function ConnectionModels({ connection, rows }: { connection: PickerConnection; rows: RowsContext }) {
  const m = leadModelMessages(rows.locale);
  const showAll = rows.expanded[connection.key] === true;
  const shown = showAll ? connection.models : connection.models.slice(0, FIRST_MODELS);
  const hidden = connection.models.length - shown.length;
  return (
    <Column testID={`lead-model-connection-models-${connection.key}`} p="inset-y" gap="nav-item">
      {connection.kind === 'subscription' ? <AccountPicker connection={connection} rows={rows} /> : null}
      {shown.map((model) => <ModelRow key={model.model} model={model} connection={connection} rows={rows} />)}
      {hidden > 0 ? (
        <Pressable testID={`lead-model-more-${connection.key}`} feedback="highlight" rounded="md" px="inset-y" py="inset-y" onPress={() => rows.onExpand(connection.key)}>
          <Text size="label" weight="semibold" tone="accent">{m.showMore(hidden)}</Text>
        </Pressable>
      ) : null}
    </Column>
  );
}

// 订阅的「账号」：缺省自动（pi-multi-pass 按换号方式换），选一个账号就固定它。只有一个账号时只写它的名字。
// 第 1 个账号的 provider 名就是订阅本身（<base>），和「自动」写法一样，所以只有第 2 个以后的账号能单独固定。
function AccountPicker({ connection, rows }: { connection: PickerConnection; rows: RowsContext }) {
  const m = leadModelMessages(rows.locale);
  const [open, setOpen] = useState(false);
  if (!connection.accounts.length) return null;
  const draftHere = rows.draft && connectionKeyOf(rows.draft.model) === connection.key ? rows.draft.model : null;
  const pinned = draftHere ? pinnedAccountOf(draftHere) : null;
  const nowIndex = accountInSession(connection.key, rows.inSession);
  const now = connection.accounts.find((entry) => entry.index === nowIndex) ?? null;
  const pinnedAccount = pinned ? connection.accounts.find((entry) => entry.provider === pinned) ?? null : null;
  const value = pinnedAccount ? accountName(pinnedAccount, rows.locale)
    : now ? m.autoNow(accountName(now, rows.locale)) : m.auto;
  const quotas = connection.quotaSupported
    ? connection.accounts.flatMap((entry) => entry.quotaUsed === null ? [] : [m.accountQuota(accountName(entry, rows.locale), entry.quotaLabel ?? '', entry.quotaUsed)])
    : [m.noQuota];
  const strategy = connection.accounts.length > 1 && connection.strategy ? m.strategy[connection.strategy] ?? null : null;
  const info = [strategy, ...quotas].filter(Boolean).join(' · ');
  const options = connection.accounts.length > 1
    ? [{ provider: null, label: m.auto }, ...connection.accounts.filter((entry) => entry.index > 1).map((entry) => ({ provider: entry.provider, label: accountName(entry, rows.locale) }))]
    : [];
  return (
    <Column testID={`lead-model-accounts-${connection.key}`} gap="nav-item" pb="inset-y" borderBottomWidth={1} borderBottomColor="border-soft">
      <Row items="center" gap="inline-item" px="inset-y" py="inset-y">
        <Text size="meta" tone="muted">{m.account}</Text>
        <Spacer />
        {options.length ? (
          <Pressable
            testID={`lead-model-account-menu-${connection.key}`}
            aria-label={m.accountMenuLabel(value)}
            aria-expanded={open}
            feedback="highlight"
            onPress={() => setOpen((current) => !current)}
            rounded="md"
            px="inset-y"
            borderWidth={1}
            borderColor="border-input"
            bg="surface"
          >
            <Row items="center" gap="icon-label">
              <Text size="label" numberOfLines={1}>{value}</Text>
              <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} color="text-secondary" />
            </Row>
          </Pressable>
        ) : <Text size="label" numberOfLines={1}>{value}</Text>}
      </Row>
      {info ? <Text testID={`lead-model-account-info-${connection.key}`} size="meta" tone="muted" px="inset-y" numberOfLines={2}>{info}</Text> : null}
      {open ? options.map((option) => {
        const chosen = option.provider === pinned;
        return (
          <Pressable
            key={option.provider ?? 'auto'}
            testID={`lead-model-account-${option.provider ?? 'auto'}`}
            aria-pressed={chosen}
            feedback="highlight"
            rounded="md"
            px="inset-y"
            py="inset-y"
            onPress={() => { rows.onAccount(connection, option.provider); setOpen(false); }}
          >
            <Row items="center" gap="inline-item">
              <Text flex={1} minW={0} size="body" weight={chosen ? 'semibold' : 'regular'} numberOfLines={1}>{option.label}</Text>
              {chosen ? <Icon name="check" size={14} color="accent" accessibilityLabel={m.selected} /> : null}
            </Row>
          </Pressable>
        );
      }) : null}
    </Column>
  );
}

function ModelRow({ model, connection, rows }: { model: LeadModelOption; connection: PickerConnection; rows: RowsContext }) {
  const m = leadModelMessages(rows.locale);
  const selected = Boolean(rows.draft && sameSlot(rows.draft.model, model.model));
  const role = chainRole(model.model, rows.chain);
  const name = model.name ?? leadModelLabel(model.model, model.prefix).id;
  // magpie 的通道（route）：同一个显示名走 auto/、claude/、codex/ 几条通道，名字后面的灰色小字把它们分开。
  const label = model.route ? `${name} · ${model.route}` : name;
  const window = rows.windows.get(model.model);
  // 账号前缀（vibeproxy 的 as4）写在说明的最前面：名字里去掉了它，不写的话两个账号的同一个模型分不清。
  const facts = [model.prefix, model.image ? m.images : null, window ? formatContextWindow(window) : null, model.efforts.length ? m.reasoning : null]
    .filter(Boolean).join(' · ');
  const blockedAt = model.blockedUntil ? new Date(model.blockedUntil) : null;
  return (
    <Pressable
      testID={`lead-model-option-${model.model}`}
      aria-label={selected ? m.selectedLabel(label) : label}
      aria-pressed={selected}
      feedback="highlight"
      onPress={() => rows.onPick(model, connection)}
      rounded="md"
      px="inset-y"
      py="inset-y"
      bg={selected ? 'accent-wash' : 'transparent'}
    >
      <Row items="center" gap="inline-item">
        <Text size="body" weight="semibold" tone={selected ? 'accent' : 'default'} numberOfLines={1} shrink={1} minW={0}>{name}</Text>
        {model.route ? <Text testID={`lead-model-route-${model.model}`} size="meta" tone="muted" numberOfLines={1} shrink={0}>{model.route}</Text> : null}
        {facts ? <Text size="meta" tone="muted" numberOfLines={1} shrink={2} minW={0}>{facts}</Text> : null}
        <Spacer />
        {blockedAt ? (
          <Badge label={m.quotaUsed(`${String(blockedAt.getHours()).padStart(2, '0')}:${String(blockedAt.getMinutes()).padStart(2, '0')}`)} tone="warning" size="sm" />
        ) : null}
        {role ? <Text testID={`lead-model-role-${model.model}`} size="meta" tone="muted">{role === 'primary' ? m.primary : m.backup}</Text> : null}
        {selected ? <Icon name="check" size={16} color="accent" accessibilityLabel={m.selected} /> : null}
      </Row>
    </Pressable>
  );
}

// 搜索全部模型：按接入分段，段头写接入的名字。一个也不剩时写一句。
function SearchResults({ connections, query, rows, sheet }: { connections: readonly PickerConnection[]; query: string; rows: RowsContext; sheet: boolean }) {
  const m = leadModelMessages(rows.locale);
  const matches = connections.flatMap((connection) => {
    const models = connection.models.filter((model) => matchesLeadModel(model, query));
    return models.length ? [{ connection, models }] : [];
  });
  const content = (
    <Column testID="lead-model-search-results" p="inset-y" gap="card-row">
      {matches.length ? null : <Text testID="lead-model-no-match" size="note" tone="muted" px="inset-y">{m.noMatch}</Text>}
      {matches.map(({ connection, models }) => (
        <Column key={connection.key} gap="nav-item">
          <Text size="meta" weight="semibold" tone="faint" px="inset-y">{connectionName(connection.key)}</Text>
          {models.map((model) => <ModelRow key={model.model} model={model} connection={connection} rows={rows} />)}
        </Column>
      ))}
    </Column>
  );
  return sheet ? content : <Box h={COLUMNS_HEIGHT}><ScrollArea nested>{content}</ScrollArea></Box>;
}

// 手机：接入一段一段，点段头展开它的账号和模型（画板 C-Picker-Mobile）。同一时间只展开一段。
function ConnectionSections({ connections, open, onToggle, rows }: {
  connections: readonly PickerConnection[];
  open: string | null;
  onToggle: (key: string) => void;
  rows: RowsContext;
}) {
  const m = leadModelMessages(rows.locale);
  const groups = [
    { title: m.subscriptionsGroup, items: connections.filter((entry) => entry.kind === 'subscription') },
    { title: m.apiKeysGroup, items: connections.filter((entry) => entry.kind === 'key') },
  ].filter((group) => group.items.length);
  return (
    <Column testID="lead-model-sections" gap="nav-item">
      {groups.map((group) => (
        <Column key={group.title}>
          <Text size="meta" weight="semibold" tone="faint" pt="inset-y">{group.title}</Text>
          {group.items.map((connection) => {
            const active = connection.key === open;
            const quota = connectionQuota(connection, rows.inSession);
            const detail = connection.kind === 'subscription' && connection.accounts.length > 1
              ? m.accountCount(connection.accounts.length) : m.modelCount(connection.models.length);
            return (
              <Column key={connection.key} borderBottomWidth={1} borderBottomColor="border-soft">
                <Pressable
                  testID={`lead-model-section-${connection.key}`}
                  aria-expanded={active}
                  aria-label={m.connectionLabel(connectionName(connection.key), connection.models.length)}
                  feedback="highlight"
                  onPress={() => onToggle(connection.key)}
                  py="row-y"
                >
                  <Row items="center" gap="inline-item">
                    <Text size="card-title" weight="semibold" numberOfLines={1} shrink={1}>{connectionName(connection.key)}</Text>
                    <Text size="meta" tone="muted" numberOfLines={1}>{detail}</Text>
                    <Spacer />
                    {quota === null ? null : <QuotaMeter used={quota} />}
                    <Icon name={active ? 'chevron-up' : 'chevron-down'} size={16} color="text-secondary" />
                  </Row>
                </Pressable>
                {active ? <ConnectionModels connection={connection} rows={rows} /> : null}
              </Column>
            );
          })}
        </Column>
      ))}
    </Column>
  );
}

// ── 入口 ─────────────────────────────────────────────────────────────────────────────

// 目录里每个模型的账号（Lead 模型分组，2026-11-05）：前缀是不是账号由 daemon 按服务商的 accountPrefix 定，
// 模型名要靠它决定去不去掉前缀。挂上时读一次目录（daemon 缓存 30 秒），读不到时当作没有账号。
export function useModelAccounts(): Map<string, string | null> {
  const runtime = useCompanionRuntime();
  const [accounts, setAccounts] = useState<Map<string, string | null>>(() => new Map());
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => runtime.loadLeadModels()).then(
      (catalog) => {
        if (live && catalog?.models) setAccounts(new Map(catalog.models.map((model) => [model.model, model.prefix])));
      },
      () => {},
    );
    return () => { live = false; };
  }, [runtime]);
  return accounts;
}

/** 回答头上、手机顶栏上写的模型：模型 id、推理强度和接入，例如「gpt-5.5 · 高 · Codex」。不知道模型时为 null。 */
export function leadModelTriggerText(spec: string | null | undefined, accounts: ReadonlyMap<string, string | null>, locale: Locale): string | null {
  if (!spec?.trim() || spec === 'unknown') return null;
  const parsed = parseLeadModelSpec(spec);
  const label = leadModelLabel(spec, accounts.get(parsed.model) ?? accounts.get(subscriptionSlotSpec(parsed.model)) ?? null);
  const base = subscriptionAccountOf(parsed.provider)?.base;
  const m = leadModelMessages(locale);
  return [label.id, label.effort ? m.effortName(label.effort) : null, base ? connectionName(base) : parsed.provider].filter(Boolean).join(' · ');
}

// 输入框工具栏右边、发送按钮前面的模型名（主题 11.18，2026-11-16 用户：「desktop 你还是放在消息输入框原来的位置」）。
// 和改版以前一样：平时只是文字（模型 id，后面淡一点的推理强度），鼠标放上去出现圆角的浅灰底，知道这里能点。
// 点开换模型的浮层，对着这个按钮。外面一层由工具栏垂直居中，和左边的「+」、右边的发送按钮对齐。
export function LeadModelComposerTrigger({ current, accounts, onOpen }: {
  current: string | null | undefined;
  accounts: ReadonlyMap<string, string | null>;
  onOpen: (anchor: PopoverAnchor) => void;
}) {
  const m = useMessages(leadModelMessages);
  const locale = useLocale();
  const ref = useRef<PopoverAnchorHandle>(null);
  const text = leadModelTriggerText(current, accounts, locale);
  // daemon 还不知道用哪个模型时（hello 里是 unknown）不写。
  if (!current?.trim() || current === 'unknown' || !text) return null;
  const parsed = parseLeadModelSpec(current);
  const label = leadModelLabel(current, accounts.get(parsed.model) ?? accounts.get(subscriptionSlotSpec(parsed.model)) ?? null);
  return (
    <PopoverAnchorView ref={ref} layout="shrink">
      <Pressable
        testID="lead-model-button"
        aria-label={m.triggerLabel(text)}
        aria-haspopup="dialog"
        feedback="none"
        onPress={() => ref.current?.measure(onOpen)}
        // spacing-exempt: 按钮的规格，左右 8、上下 6，高 28（文字行高 16），和改版以前一样
        px={8}
        py={6} // spacing-exempt: 按钮的规格，上下 6（见上一行）
        rounded="sm"
        bg={{ default: 'transparent', hover: 'surface-muted' }}
      >
        <Row items="center" gap="icon-label" minW={0}>
          <Text testID="composer-model" size="label" tone="secondary" numberOfLines={1} shrink={1} minW={0}>{label.id}</Text>
          {label.effort ? <Text testID="composer-model-effort" size="label" tone="muted" numberOfLines={1} shrink={0}>{label.effort}</Text> : null}
        </Row>
      </Pressable>
    </PopoverAnchorView>
  );
}

// 没有回答的那一轮里的「换个模型重发」（画布「没有回答」状态 2）：点开同一个浮层。
// 「只这一条」用选的模型重发你那句话一次；「换成主用」换好（或者排在这一轮之后）再重发。
export function LeadModelResendLink({ onResend }: { onResend: (turnModel?: LeadModelChoice) => void }) {
  const m = useMessages(leadModelMessages);
  const ref = useRef<PopoverAnchorHandle>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  return (
    <>
      <PopoverAnchorView ref={ref}>
        <Pressable testID="lead-model-resend-button" aria-label={m.resend} feedback="highlight" rounded="sm" onPress={() => ref.current?.measure(setAnchor)}>
          <Text size="secondary" weight="semibold" tone="accent">{m.resend}</Text>
        </Pressable>
      </PopoverAnchorView>
      <LeadModelPicker
        testID="lead-model-resend"
        open={anchor !== null}
        anchor={anchor}
        onClose={() => setAnchor(null)}
        onTurnModel={(choice) => onResend(choice)}
        onSwitched={() => onResend()}
      />
    </>
  );
}

// 输入框上面的小标签：下一条消息用的单轮模型（「只这一条」），点 × 去掉。发出以后消失。
export function TurnModelChip({ text, onRemove }: { text: string; onRemove: () => void }) {
  const m = useMessages(leadModelMessages);
  return (
    <Row testID="turn-model-chip" self="flex-start" items="center" gap="icon-label" pl="pill-x" rounded="full" bg="accent-wash" maxW="100%">
      <Icon name="sparkle" size={12} color="accent" />
      <Text size="label" weight="semibold" tone="accent" numberOfLines={1} shrink={1} minW={0}>{m.chip(text)}</Text>
      <Pressable testID="turn-model-chip-remove" aria-label={m.chipRemove} feedback="highlight" rounded="full" px="pill-x" py="pill-y" onPress={onRemove}>
        <Icon name="close" size={12} color="accent" />
      </Pressable>
    </Row>
  );
}
