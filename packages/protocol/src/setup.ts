// 首次启动引导（2026-10-30，.scratch/onboarding/spec.md）：7 项关键设置配没配好。
// - daemon 算（apps/daemon 的 setup-status.ts），结果存在 kv（setup.status），网关和 Lead 都从那里读。
// - GET /v1/setup（tickets:view）给 App：大脑不能用时，App 整页显示首次启动页。
// - 会话里的准备清单卡（首次上线一次）和建议卡（之后每轮结束时）也用这里的项和文字。
// 文字里的 {lead} 由 App 换成用户给 Lead 起的名字（设置 → 身份与风格）。
import { Type, type Static, type TProperties, type TSchema } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const SETUP_RESOURCE = "setup";

// 顺序就是清单的顺序，也是建议卡挑项的顺序。
export const SETUP_ITEM_KEYS = ["brain", "memory", "slack", "profile", "github", "jira", "notion"] as const;
export type SetupItemKey = (typeof SETUP_ITEM_KEYS)[number];
export const SetupItemKeySchema = Type.Union([
  Type.Literal("brain"), Type.Literal("memory"), Type.Literal("slack"), Type.Literal("profile"),
  Type.Literal("github"), Type.Literal("jira"), Type.Literal("notion"),
]);

export interface SetupItemMeta {
  title: string;
  // 没配时说一句配了有什么用。
  why: string;
  // 按钮上的字。
  cta: string;
  // 去哪里配（App 的路由）。
  href: string;
}

export const SETUP_ITEMS: Readonly<Record<SetupItemKey, SetupItemMeta>> = Object.freeze({
  brain: { title: "大脑模型", why: "{lead} 靠大模型思考和对话。", cta: "去设置", href: "/settings/model" },
  memory: { title: "记忆 embedding", why: "没配时 {lead} 只能按关键词回想；配上以后能按意思找到以前的事。", cta: "去设置", href: "/settings/memory" },
  slack: { title: "Slack", why: "填两个 token，打开「自动代你处理」，{lead} 就能替你看和回 Slack。", cta: "去设置", href: "/settings/channels" },
  profile: { title: "身份与风格", why: "改 {lead} 的名字和性格，告诉它你喜欢怎么沟通。", cta: "去看看", href: "/settings/profile" },
  github: { title: "GitHub", why: "连上以后，{lead} 能看 PR、留 review、跟进 CI。", cta: "去连接", href: "/settings/connections/github" },
  jira: { title: "Jira", why: "连上以后，{lead} 能查工单、更新状态，把讨论记到工单里。", cta: "去连接", href: "/settings/connections/atlassian" },
  notion: { title: "Notion", why: "连上以后，{lead} 能读写你的文档和数据库。", cta: "去连接", href: "/settings/connections/notion" },
});

// 卡片能跳去的路由只有这些（卡上的 open.href）。
export const SETUP_HREFS: readonly string[] = Object.freeze(SETUP_ITEM_KEYS.map((key) => SETUP_ITEMS[key].href));

export const SetupItemSchema = StrictObject({
  key: SetupItemKeySchema,
  ready: Type.Boolean(),
  // 配好时的一句现状，例如「Claude Sonnet 5.5（anthropic）」「已连接」。没配或者说不出时是 null。
  detail: Nullable(Type.String({ maxLength: 120 })),
});
export type SetupItem = Static<typeof SetupItemSchema>;

export const SetupStatusSchema = StrictObject({
  // 按 SETUP_ITEM_KEYS 的顺序，7 项都在。
  items: Type.Array(SetupItemSchema, { maxItems: SETUP_ITEM_KEYS.length }),
  // 最近一次有项变了的时间（只重算、没变化时不动）。
  changedAt: Type.String(),
});
export type SetupStatus = Static<typeof SetupStatusSchema>;

export const SetupResponseSchema = StrictObject({
  // daemon 还没算过（刚启动）时是 null。
  setup: Nullable(SetupStatusSchema),
});
export type SetupResponse = Static<typeof SetupResponseSchema>;

/** 大脑能不能用。还没算过时当作能用：不能因为一次没算完就把整个 App 挡住。 */
export function setupBrainReady(status: SetupStatus | null): boolean {
  return status?.items.find((item) => item.key === "brain")?.ready ?? true;
}

// 卡上的「打开设置页」：App 自己跳转，不调后端。href 只能是 SETUP_HREFS 里的。
export const SetupOpenSchema = StrictObject({ href: Type.String({ minLength: 1, maxLength: 80 }) });

// 准备清单卡（首次上线时建一次，之后原地更新）。key 和 entityKey 都是 setup:checklist。
export const SETUP_CHECKLIST_KEY = "setup:checklist";
export const SetupChecklistCardSchema = StrictObject({
  key: Type.Literal(SETUP_CHECKLIST_KEY),
  entityKey: Type.Literal(SETUP_CHECKLIST_KEY),
  // 设置状态变化的时间（毫秒）。客户端只接受不比手上旧的版本。
  entityVersion: Type.Integer({ minimum: 1 }),
  // 卡在会话里的位置：建卡的时间（Lead 第一次上线）。
  at: Type.String(),
  updatedAt: Type.String(),
  items: Type.Array(SetupItemSchema, { maxItems: SETUP_ITEM_KEYS.length }),
});
export type SetupChecklistCard = Static<typeof SetupChecklistCardSchema>;

// 建议卡上的按钮：和 lead-activity.ts 的 LeadActivityCardAction 一个样子（lead-activity.ts 引用本文件，这里不能反过来引用它）。
export const SetupHintActionSchema = StrictObject({
  target: StrictObject({ type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }),
  action: Type.String({ minLength: 1, maxLength: 64 }),
  label: Type.String({ minLength: 1 }),
});

// 建议卡（之后每轮结束时，一次一项）。
// open：还在建议；snoozed：你点了「以后再说」；dismissed：你点了「不用再提」；ready：这一项后来配好了。
export const SetupHintStateSchema = Type.Union([
  Type.Literal("open"), Type.Literal("snoozed"), Type.Literal("dismissed"), Type.Literal("ready"),
]);
export type SetupHintState = Static<typeof SetupHintStateSchema>;

export const SetupHintCardSchema = StrictObject({
  // setup_hint:<编号>
  key: Type.String({ minLength: 1 }),
  entityKey: Type.String({ minLength: 1 }),
  entityVersion: Type.Integer({ minimum: 1 }),
  // 卡在会话里的位置：那一轮结束的时间。
  at: Type.String(),
  updatedAt: Type.String(),
  hintId: Type.Integer({ minimum: 1 }),
  item: SetupItemKeySchema,
  state: SetupHintStateSchema,
  // open 时的两个操作：snooze（以后再说）、dismiss（不用再提）。其他状态没有。
  actions: Type.Array(SetupHintActionSchema, { maxItems: 2 }),
});
export type SetupHintCard = Static<typeof SetupHintCardSchema>;

// 建议卡的冷却（spec R4）。
export const SETUP_HINT_ITEM_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const SETUP_HINT_ANY_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000;
