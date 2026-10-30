// 自定义控件（用户 2026-10-30，.scratch/custom-views/spec.md D1、D7）的操作：视图面板（widget_board）上建控件、排序、视图改名，
// 一个控件（widget）上改和删。页面（POST /v1/actions/widget_board/widgets/<操作>、/v1/actions/widget/<编号>/<操作>）和
// Lead（perform_action）调同一个定义。
//   - 都是 lead_allowed，不算改规则：控件只是显示，不进 Lead 的提示词，不改 Lead 的行为。外部消息叫醒的一轮也能做
//     （第一期没有数据源；数据源是第二期，到时候新建和改数据源另有底线，spec D7）。
//   - 视图是控件的一个属性，缺省 default。只有用户明确要按类别分成几个视图时，Lead 才给 view（用户 2026-10-30）。
//   - 模板和 render_ui 同一个写法，同一个校验（protocol 的 buildWidgetSurface），另外不能用一次性的组件。
//   - 卡片上的按钮（Action）和 render_ui 一样：对象要在，操作要登记过，只有用户本人能做的操作（user_direct）不能做成按钮。
//   - 删了不能恢复：irreversible，页面在按钮上就地确认（confirm），Lead 只在用户这一轮明确要删时带 confirm。
//   - 每次改动以后推 snapshot.required（resource=widgets），各端重新读 GET /v1/widgets。
import {
  buildWidgetSurface, resolveWidgetTemplate, viewLabel, WIDGET_LIMITS, WIDGET_SOURCE_LIMITS, WIDGETS_RESOURCE, widgetTemplateBinds, widgetViews,
  type UiSurface, type ViewRenameRequest, type WidgetCreateRequest, type WidgetDto, type WidgetReorderRequest, type WidgetSourceInput,
  type WidgetSurfaceInput, type WidgetUpdateRequest,
} from "@pi-lead-child/protocol";
import {
  clearWidgetSource, countWidgets, createWidget, deleteWidget, getItem, getWidget, getWidgetSource, listWidgets, publishGatewayEvent, renameView,
  reorderWidgets, requestWidgetRefresh, setWidgetSource, updateWidget, WidgetStoreError, type Db, type WidgetSource,
} from "@pi-lead-child/store";
import { runWidgetSource } from "../pipeline/widget-source-runner.js";
import { ticketActionDefinition } from "../ticket-actions/index.js";
import { AVAILABLE, permissionOf, unavailable } from "../ticket-actions/types.js";
import { UI_ACTIONS } from "./catalog.js";
import { UiActionError, type UiActionDefinition, type UiActionEnv, type UiActionRun, type UiActionTargetKind } from "./types.js";

export const WIDGETS_WHERE = "会话顶栏右边的「自定义视图」面板";

// 视图面板只有一个，编号是 widgets。
export interface WidgetBoard {
  widgets: WidgetDto[];
}

function positiveId(id: string): number | null {
  const value = Number(id);
  return Number.isSafeInteger(value) && value >= 1 && String(value) === id ? value : null;
}

export const WIDGET_BOARD_TARGET: UiActionTargetKind<WidgetBoard> = {
  type: "widget_board",
  label: "自定义视图面板",
  idHint: "widgets",
  load: (env, id) => (id === "widgets" ? { widgets: listWidgets(env.db) } : null),
  name: () => "自定义视图面板",
  // 给 Lead 看：有哪些视图（tab 的顺序）、每个控件的编号、标题和所在的视图。要改某一个时，用 list_actions 读那个控件的模板。
  describe: (board) => ({
    views: widgetViews(board.widgets).map((view) => ({ view, label: viewLabel(view) })),
    widgets: board.widgets.map((widget) => ({ id: widget.id, title: widget.title, view: widget.view })),
    max: { widgets: WIDGET_LIMITS.widgets, views: WIDGET_LIMITS.views },
  }),
};

// 一个控件，加上它的数据源设置（命令、模板），给 Lead 的 describe 用。
export type WidgetTarget = WidgetDto & { config: WidgetSource | null };

export const WIDGET_TARGET: UiActionTargetKind<WidgetTarget> = {
  type: "widget",
  label: "控件",
  idHint: "控件的编号（widget_board 的 widgets 里的 id）",
  load: (env, id) => {
    const widgetId = positiveId(id);
    const widget = widgetId === null ? null : getWidget(env.db, widgetId);
    return widget ? { ...widget, config: getWidgetSource(env.db, widget.id) } : null;
  },
  name: (widget) => `控件「${widget.title}」`,
  // 给 Lead 看：现在的模板，改的时候在它上面改。写法和 render_ui 的参数一样。有数据源时给的是带绑定的模板，
  // 不是解析好的那一块（数据是外部内容，不给 Lead 看），另外给命令、间隔和数据源现在的状态。
  describe: (widget) => ({
    title: widget.title,
    view: widget.view,
    surface: widget.config?.template ?? { root: widget.surface.root, nodes: widget.surface.nodes, fallback_text: widget.surface.fallbackText },
    source: widget.config ? {
      command: widget.config.command, every_seconds: widget.config.everySeconds, last_ok_at: widget.config.lastOkAt,
      last_error: widget.config.lastError, paused: widget.config.paused,
    } : null,
    createdBy: widget.createdBy,
    updatedAt: widget.updatedAt,
  }),
};

function changed(db: Db, now: Date): void {
  publishGatewayEvent(db, { type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: WIDGETS_RESOURCE }, now });
}

function storeError<T>(write: () => T): T {
  try {
    return write();
  } catch (error) {
    if (error instanceof WidgetStoreError) {
      throw new UiActionError(error.code === "limit" ? "unavailable" : error.code === "not_found" ? "not_found" : "invalid_input", error.message);
    }
    throw error;
  }
}

// 视图名：去掉两头的空白，不能是空的。
function viewName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const name = value.trim();
  if (!name) throw new UiActionError("invalid_input", "视图名不能是空的");
  return name;
}

/** 模板变成控件的 surface。不合格时拒绝，错误带路径（和 render_ui 给 Lead 的一样）。 */
function surfaceOf(db: Db, widgetId: number, input: unknown): UiSurface {
  const built = buildWidgetSurface(widgetId, input);
  if (!built.ok) {
    throw new UiActionError("invalid_input", `模板不合格：${built.errors.map((error) => `${error.path} ${error.message}`).join("；")}`);
  }
  checkActionButtons(db, built.surface);
  return built.surface;
}

// 卡片上的按钮：对象要在，操作要登记过；只有用户本人能做的操作（user_direct）不能做成按钮（和 render_ui 一样）。
// 能不能按不在这里判断：按钮显示时由客户端用同一个函数实时判断。
function checkActionButtons(db: Db, surface: UiSurface): void {
  for (const node of surface.nodes) {
    if (node.type !== "Action") continue;
    const props = node.props as { target: { type: string; id: string | number }; action: string };
    if (props.target.type === "ticket") {
      const item = getItem(db, Number(props.target.id));
      if (!item) throw new UiActionError("invalid_input", `Action ${node.id} 指向的工单 #${props.target.id} 不存在`);
      const definition = ticketActionDefinition(props.action);
      if (!definition) throw new UiActionError("invalid_input", `工单没有操作 ${props.action}`);
      if (permissionOf(definition, item) === "user_direct") {
        throw new UiActionError("invalid_input", `${definition.label}只有用户本人能在页面上做，不能做成控件里的按钮`);
      }
      continue;
    }
    const definition = (UI_ACTIONS as Record<string, Record<string, UiActionDefinition> | undefined>)[props.target.type]?.[props.action];
    if (!definition) throw new UiActionError("invalid_input", `${props.target.type} 没有操作 ${props.action}`);
    if (definition.permission === "user_direct") {
      throw new UiActionError("invalid_input", `${definition.label}只有用户本人能做（${typeof definition.where === "string" ? definition.where : "设置页"}），不能做成控件里的按钮`);
    }
  }
}

// 带数据源的模板先跑一次命令：模板里要有绑定，命令的输出要能画成合格的卡。返回解析好的模板（编号换成控件的以后再校验一次）。
async function firstRun(env: UiActionEnv, widgetId: number, template: WidgetSurfaceInput, source: WidgetSourceInput): Promise<WidgetSurfaceInput> {
  const run = env.services.widgetCommands;
  if (!run) throw new UiActionError("unavailable", "这里不能跑数据源的命令（daemon 没有接沙箱）");
  if (!widgetTemplateBinds(template)) {
    throw new UiActionError("invalid_input", "模板里没有绑定：数据要显示的地方写 {\"$data\": \"字段\"}（整个值）或者 \"{{字段}}\"（文字里）");
  }
  const result = await runWidgetSource(run, widgetId, template, source.command);
  if (!result.ok) throw new UiActionError("invalid_input", `数据源没跑通：${result.error}。先在 bash 里把命令跑通，确认标准输出只有一个 JSON 对象`);
  const resolved = resolveWidgetTemplate(template, result.data);
  if (!resolved.ok) throw new UiActionError("invalid_input", resolved.error);
  return resolved.input;
}

const actorOf = (run: UiActionRun<unknown, unknown>) => (run.by.actor === "user" ? "user" as const : "lead" as const);

export const WIDGET_BOARD_ACTIONS = {
  create: {
    target: "widget_board", id: "create", label: "建控件", scope: "chat",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: WIDGETS_WHERE,
    hint: "用户要一个常驻的小界面（例如「做一个显示某某的控件」）时，建一个控件：title 是标题，surface 是模板，写法和 render_ui 的参数一样"
      + "（root、nodes、fallback_text），组件也一样，只是不能用 ChoiceGroup、UserAction、确认卡、SourceQuote、Message、Intervention、ChannelCard。"
      + "画之前先读 skill genui-cards。新控件排在最上面。第一期的控件是快照：数字不会自己更新，数据有时效时在模板里写明是什么时候的数据。"
      + "view 不给：控件放进缺省的视图。只有用户明确要按类别分成几个视图（面板上的 tab）时才给 view，写视图名，例如「投资」。"
      + "要自动更新的数据（指数、天气、CI 状态）给 source：{ command, every_seconds }。系统按间隔在你的 bash 沙箱里跑 command，"
      + `标准输出只能是一个 JSON 对象（最多 ${WIDGET_SOURCE_LIMITS.outputBytes} 字节，${WIDGET_SOURCE_LIMITS.timeoutSeconds} 秒内跑完，`
      + `间隔至少 ${WIDGET_SOURCE_LIMITS.minEverySeconds} 秒）。surface 这时是模板：属性的整个值写 {"$data": "字段"}（例如 Tile 的 value、`
      + "BarChart 的 bars），文字里写 {{字段}}（例如 caption 写 \"更新于 {{time}}\"），路径用点分，数组用数字下标。涨跌颜色、格式化都在命令里算好。"
      + "建的时候系统先跑一次，跑不通就不建。之后刷新不叫醒你，不花 token；连续出错 5 次会暂停并叫醒你一次。"
      + "不要用后台检查（watch）加你重画来刷新控件",
    defaultReason: "用户要一个常驻的控件",
    available: (board: WidgetBoard) => (board.widgets.length >= WIDGET_LIMITS.widgets
      ? unavailable(`已经有 ${WIDGET_LIMITS.widgets} 个控件了，先删掉不用的`)
      : AVAILABLE),
    run: async (run: UiActionRun<WidgetBoard, WidgetCreateRequest>) => {
      const view = viewName(run.input.view);
      const source = run.input.source;
      // 有数据源时先跑一次，用这次的数据解析模板；控件的内容是解析好的那一块。
      const shown = source ? await firstRun(run.env, 1, run.input.surface, source) : run.input.surface;
      // 模板不合格时 surfaceOf 抛错，建行的事务整个撤回。
      const widget = storeError(() => run.db.transaction(() => {
        const created = createWidget(
          run.db,
          { title: run.input.title, ...(view === undefined ? {} : { view }), createdBy: actorOf(run), now: run.env.now },
          (id) => surfaceOf(run.db, id, shown),
        );
        if (source) setWidgetSource(run.db, created.id, { template: run.input.surface, command: source.command, everySeconds: source.every_seconds, now: run.env.now });
        return getWidget(run.db, created.id)!;
      })());
      changed(run.db, run.env.now);
      return widget;
    },
    forLead: (_run, result) => {
      const widget = result as WidgetDto;
      return {
        result: "created", widget: { id: widget.id, title: widget.title, view: widget.view },
        ...(widget.source ? { source: { every_seconds: widget.source.everySeconds } } : {}),
        next: widget.source
          ? `控件在面板最上面，数据每 ${widget.source.everySeconds} 秒自动更新，不用你再管。用户点顶栏右边的「自定义视图」就能看到。`
          : "控件在面板最上面。用户点顶栏右边的「自定义视图」就能看到。",
      };
    },
    detail: (_run, result) => ({ widgetId: (result as WidgetDto).id, title: (result as WidgetDto).title, view: (result as WidgetDto).view }),
  },
  reorder: {
    target: "widget_board", id: "reorder", label: "排控件的顺序", scope: "chat",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: WIDGETS_WHERE,
    hint: "按用户说的顺序排控件：ids 列出全部控件的编号，从上到下，每个一次（各个视图的控件混在一起排，每个视图里按这个先后显示）。",
    defaultReason: "调整控件的顺序",
    available: (board: WidgetBoard) => (board.widgets.length < 2 ? unavailable("控件少于两个，不用排") : AVAILABLE),
    run: (run: UiActionRun<WidgetBoard, WidgetReorderRequest>) => {
      const widgets = storeError(() => reorderWidgets(run.db, run.input.ids, run.env.now));
      changed(run.db, run.env.now);
      return widgets;
    },
    forLead: (_run, result) => ({ result: "reordered", ids: (result as WidgetDto[]).map((widget) => widget.id) }),
    detail: (run) => ({ ids: run.input.ids }),
  },
  rename_view: {
    target: "widget_board", id: "rename_view", label: "视图改名", scope: "chat",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: WIDGETS_WHERE,
    hint: "给一个视图（面板上的 tab）改名：view 是现在的名字（缺省的视图是 default），name 是新名字。"
      + "这个视图里的控件一起换到新名字下；新名字已经有了时两个视图合成一个。",
    defaultReason: "按用户的要求给视图改名",
    available: (board: WidgetBoard) => (board.widgets.length === 0 ? unavailable("还没有控件，也就没有视图") : AVAILABLE),
    run: (run: UiActionRun<WidgetBoard, ViewRenameRequest>) => {
      const name = viewName(run.input.name)!;
      const moved = storeError(() => renameView(run.db, run.input.view, name, run.env.now));
      changed(run.db, run.env.now);
      return { view: name, widgets: moved };
    },
    forLead: (run, result) => ({ result: "renamed", from: run.input.view, ...(result as { view: string; widgets: number }) }),
    detail: (run) => ({ from: run.input.view, to: run.input.name }),
  },
} satisfies Record<string, UiActionDefinition<WidgetBoard, any>>;

export const WIDGET_ACTIONS = {
  update: {
    target: "widget", id: "update", label: "改控件", scope: "chat",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: WIDGETS_WHERE,
    hint: "改一个控件的标题、模板（surface，写法和 render_ui 的参数一样，整块替换）、所在的视图（view，移到别的 tab）"
      + "或者数据源（source：{ command, every_seconds }；给 null 去掉数据源，控件停在最后一次的内容上）。"
      + "有数据源的控件，surface 是带 {\"$data\": …} 绑定的模板，改了以后系统马上跑一次命令，跑不通就不改。"
      + "改模板前先用 list_actions 读现在的模板，在它上面改。",
    defaultReason: "按用户的要求改控件",
    available: () => AVAILABLE,
    run: async (run: UiActionRun<WidgetTarget, WidgetUpdateRequest>) => {
      const input = run.input;
      if (input.title === undefined && input.surface === undefined && input.view === undefined && input.source === undefined) {
        throw new UiActionError("invalid_input", "要给 title、surface、view 或 source，至少一样");
      }
      const view = viewName(input.view);
      const current = run.target.config;
      // 用哪个数据源、哪个模板：给了新的用新的；source 是 null 时去掉数据源；都没给时沿用现在的。
      const source = input.source === null ? null : input.source ?? (current ? { command: current.command, every_seconds: current.everySeconds } : null);
      const template = input.surface ?? current?.template;
      const rerun = source !== null && template !== undefined && (input.source != null || input.surface !== undefined);
      let surface: UiSurface | undefined;
      if (rerun) surface = surfaceOf(run.db, run.target.id, await firstRun(run.env, run.target.id, template!, source!));
      else if (input.surface !== undefined) surface = surfaceOf(run.db, run.target.id, input.surface);
      const widget = storeError(() => run.db.transaction(() => {
        const updated = updateWidget(run.db, run.target.id, { title: input.title, surface, view, now: run.env.now });
        if (!updated) return null;
        if (input.source === null) clearWidgetSource(run.db, run.target.id);
        else if (rerun) setWidgetSource(run.db, run.target.id, { template: template!, command: source!.command, everySeconds: source!.every_seconds, now: run.env.now });
        return getWidget(run.db, run.target.id);
      })());
      if (!widget) throw new UiActionError("not_found", `控件 #${run.target.id} 不在了`);
      changed(run.db, run.env.now);
      return widget;
    },
    forLead: (_run, result) => {
      const widget = result as WidgetDto;
      return { result: "updated", widget: { id: widget.id, title: widget.title, view: widget.view } };
    },
    detail: (run) => ({
      widgetId: run.target.id, title: run.input.title ?? null, view: run.input.view ?? null, surface: run.input.surface !== undefined,
      source: run.input.source === undefined ? "unchanged" : run.input.source === null ? "removed" : { every_seconds: run.input.source.every_seconds },
    }),
  },
  refresh: {
    target: "widget", id: "refresh", label: "刷新控件", scope: "chat",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: WIDGETS_WHERE,
    hint: "马上跑一次控件的数据源（几秒内）。数据源因为连续出错暂停了的，修好以后用它接着跑。",
    defaultReason: "马上刷新控件的数据",
    available: (widget: WidgetTarget) => (widget.config ? AVAILABLE : unavailable("这个控件没有数据源，是快照")),
    run: (run: UiActionRun<WidgetTarget, Record<string, never>>) => {
      if (!requestWidgetRefresh(run.db, run.target.id, run.env.now)) throw new UiActionError("unavailable", "这个控件没有数据源，是快照");
      changed(run.db, run.env.now);
      return getWidget(run.db, run.target.id);
    },
    forLead: () => ({ result: "refresh_requested", next: "系统几秒内跑一次，不用等它。" }),
    detail: (run) => ({ widgetId: run.target.id }),
  },
  delete: {
    target: "widget", id: "delete", label: "删控件", scope: "chat",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: true,
    where: WIDGETS_WHERE,
    hint: "删掉一个控件。删了不能恢复：只在用户明确要删时做，input 带 confirm: true。视图里的控件都删完，这个视图就没了。",
    defaultReason: "删掉不用的控件",
    available: () => AVAILABLE,
    confirm: (widget: WidgetTarget) => `删掉控件「${widget.title}」，删了不能恢复。`,
    run: (run: UiActionRun<WidgetTarget, { confirm?: true }>) => {
      const widget = deleteWidget(run.db, run.target.id);
      if (!widget) throw new UiActionError("not_found", `控件 #${run.target.id} 不在了`);
      changed(run.db, run.env.now);
      return { deleted: widget.id, remaining: countWidgets(run.db) };
    },
    forLead: (run) => ({ result: "deleted", widget: { id: run.target.id, title: run.target.title } }),
    detail: (run) => ({ widgetId: run.target.id, title: run.target.title }),
  },
} satisfies Record<string, UiActionDefinition<WidgetTarget, any>>;
