import { Type, type Static, type TProperties } from "typebox";

// 控件的操作的 input（widgets.ts）。单独一个文件：ui-actions.ts 要引用这些 schema，
// 而 ui-surfaces.ts 引用 ui-actions.ts，从 ui-surfaces.ts 取 schema 会循环引用。
// 所以这里的模板只查形状，节点数、字节数、组件目录这些限制由 widgets.ts 的 buildWidgetSurface（validateUiSurface）查。

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const WIDGET_LIMITS = {
  // 同时最多几个控件。
  widgets: 20,
  title: 40,
  // 最多几个视图（面板上的 tab）。视图名最长几个字：tab 在面板的一行里放得下。
  views: 6,
  viewName: 10,
} as const;

// 数据源（第二期，spec D3）：daemon 按间隔在 Lead 的 bash 沙箱里跑一条命令，命令的输出是一个 JSON 对象，
// 控件的模板用 {"$data": "路径"} 和 "{{路径}}" 绑定它的字段。跑数据源不叫醒 Lead。
export const WIDGET_SOURCE_LIMITS = {
  // 两次之间最短、最长（秒）。
  minEverySeconds: 60,
  maxEverySeconds: 86_400,
  // 一次最多跑多久（秒），输出最多多少字节（和 surface 的上限一样）。
  timeoutSeconds: 30,
  outputBytes: 16 * 1024,
  // 连续出错几次就暂停，并叫醒 Lead 一次。
  maxConsecutiveErrors: 5,
  command: 4_000,
} as const;

export const WidgetSourceInputSchema = StrictObject({
  command: Type.String({ minLength: 1, maxLength: WIDGET_SOURCE_LIMITS.command }),
  every_seconds: Type.Integer({ minimum: WIDGET_SOURCE_LIMITS.minEverySeconds, maximum: WIDGET_SOURCE_LIMITS.maxEverySeconds }),
});
export type WidgetSourceInput = Static<typeof WidgetSourceInputSchema>;

// 缺省的视图（用户 2026-10-30）：控件不说属于哪个视图时就在这里。只有它一个视图时面板不显示 tab。
export const DEFAULT_VIEW = "default";
export const DEFAULT_VIEW_LABEL = "常用";

/** 视图在 tab 上的名字。 */
export function viewLabel(view: string): string {
  return view === DEFAULT_VIEW ? DEFAULT_VIEW_LABEL : view;
}

export const ViewNameSchema = Type.String({ minLength: 1, maxLength: WIDGET_LIMITS.viewName });

// 操作的 input 里的模板：和 render_ui 的参数同一个形状，Lead 不用换写法。
export const WidgetSurfaceInputSchema = StrictObject({
  root: Type.String({ minLength: 1, maxLength: 64 }),
  nodes: Type.Array(Type.Object({
    id: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 1 }),
    props: Type.Record(Type.String(), Type.Unknown()),
    children: Type.Optional(Type.Array(Type.String())),
  }), { minItems: 1 }),
  fallback_text: Type.String({ minLength: 1, maxLength: 2_000 }),
});
export type WidgetSurfaceInput = Static<typeof WidgetSurfaceInputSchema>;

const WidgetTitleSchema = Type.String({ minLength: 1, maxLength: WIDGET_LIMITS.title });

// view 不给时放进缺省的视图。
// 有 source 时 surface 是模板：建的时候先跑一次命令，用它的输出解析模板，合格了才建。
export const WidgetCreateRequestSchema = StrictObject({
  title: WidgetTitleSchema,
  surface: WidgetSurfaceInputSchema,
  view: Type.Optional(ViewNameSchema),
  source: Type.Optional(WidgetSourceInputSchema),
});
export type WidgetCreateRequest = Static<typeof WidgetCreateRequestSchema>;

// 改标题、模板、所在的视图，至少给一样（操作的 run 里检查）。
// source 给 null 时去掉数据源，控件停在最后一次的内容上。
export const WidgetUpdateRequestSchema = StrictObject({
  title: Type.Optional(WidgetTitleSchema),
  surface: Type.Optional(WidgetSurfaceInputSchema),
  view: Type.Optional(ViewNameSchema),
  source: Type.Optional(Type.Union([WidgetSourceInputSchema, Type.Null()])),
});
export type WidgetUpdateRequest = Static<typeof WidgetUpdateRequestSchema>;

// 新的顺序：全部控件的编号，从上到下。
export const WidgetReorderRequestSchema = StrictObject({
  ids: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: WIDGET_LIMITS.widgets }),
});
export type WidgetReorderRequest = Static<typeof WidgetReorderRequestSchema>;

// 视图改名：这个视图里的控件一起换到新名字下。新名字已经有了时，两个视图合成一个。
export const ViewRenameRequestSchema = StrictObject({
  view: ViewNameSchema,
  name: ViewNameSchema,
});
export type ViewRenameRequest = Static<typeof ViewRenameRequestSchema>;
