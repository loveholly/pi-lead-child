// 信号源的操作（用户 2026-11-11、2026-11-12，protocol 的 signal-sources.ts）：用户通过对话让 Lead 把一个连接
// （例如邮箱、日历）接进事件体系。页面（通用入口 /v1/actions/…）和 Lead（perform_action）调同一个定义。
//   signal_sources（编号 signals）：create 建、test 试跑。
//   signal_source（编号是名字）：update 改、pause 暂停、resume 恢复、run 马上跑一次、delete 删。
// 谁能做：都是 lead_allowed。建、改、暂停、恢复、删是改规则：带着外部内容的一轮里 Lead 做不了（只拒绝，不发确认卡），
// 用户本人正在说话的一轮不受这个限制（AGENTS.md D10）。别人写的话不能让 Lead 开一个订阅、关一个订阅、
// 或者把「先问用户」改成「代用户处理」。
// 建和改命令以前先试跑一次：调的工具必须是只读的，命令要跑通，输出要合格。
// 给 Lead 的结果里没有条目的原文：标题和正文是别人写的话，perform_action 的结果不算外部内容。Lead 只看到条数和形状；
// 要看内容时用 call_connection_tool（那一轮就算读过外部内容）。页面入口拿完整的结果。
import {
  SIGNAL_DEFAULT_POLICY, SIGNAL_SOURCE_LIMITS, type SignalItem, type SignalSourceDto, type SignalSourceInput, type SignalSourceUpdate,
} from "@pi-lead-child/protocol";
import {
  createSignalSource, deleteSignalSource, getAgendaFeed, getSignalSource, listSignalSources, updateSignalSource,
} from "@pi-lead-child/store";
import { AVAILABLE } from "../ticket-actions/types.js";
import { UiActionError, type SignalSourceService, type UiActionDefinition, type UiActionEnv, type UiActionTargetKind } from "./types.js";

const WHERE = "主对话：告诉 Lead 要接什么、哪些要马上告诉你（还没有设置页）";
const EXTERNAL_NEXT = "这一轮不建、不改。在回复里告诉用户你想做什么、为什么，等用户本人的下一轮再做";
const RULES = {
  permission: "lead_allowed", changesRules: true, externalRefusalNext: EXTERNAL_NEXT, liveUserTurnExempt: true,
  external: false, irreversible: false, where: WHERE, scope: "tickets:create",
} as const;

export interface SignalSourcesTarget {
  sources: SignalSourceDto[];
}

// 给 Lead 看的一个信号源：配置和运行状态都是系统的数据，没有别人写的话。
function sourceView(source: SignalSourceDto) {
  return {
    name: source.name, label: source.label, enabled: source.enabled, everySeconds: source.everySeconds,
    fetch: source.fetch, command: source.command, rules: source.rules,
    policy: source.policy || SIGNAL_DEFAULT_POLICY, actForUser: source.actForUser,
    lastRunAt: source.lastRunAt, lastStatus: source.lastStatus, lastError: source.lastError,
    consecutiveErrors: source.consecutiveErrors, emitted: source.emitted, nextRunAt: source.enabled ? source.nextRunAt : null,
    agendaFeed: source.agendaFeed,
  };
}

// 条目的形状，不带原文。
function shapeOf(items: TryOut) {
  return {
    items: items.length,
    ...(items.agenda ? { agendaEntries: items.agenda.entries.length } : {}),
    samples: items.slice(0, 3).map((item) => ({
      keyChars: item.key.length, titleChars: item.title.length, textChars: item.text.length,
      hasTime: item.at !== undefined, fields: Object.keys(item.fields ?? {}).slice(0, 12).map((name) => name.slice(0, 40)),
    })),
  };
}

function serviceOf(env: UiActionEnv): SignalSourceService {
  const service = env.services.signalSources;
  if (!service) throw new UiActionError("unavailable", "这里不能跑信号源（daemon 没有接连接或者沙箱）");
  return service;
}

// A source handing its output to an agenda feed: the feed must exist and the try-out must give an `agenda` array.
function checkAgendaFeed(env: UiActionEnv, feed: string | null | undefined, tried: TryOut): void {
  if (!feed) return;
  if (!getAgendaFeed(env.db, feed)) {
    throw new UiActionError("invalid_input", `没有外部日程 ${feed}：先用 agenda_feeds 的 create 建它`);
  }
  if (!tried.agenda) {
    throw new UiActionError("invalid_input", "接外部日程的信号源，命令的输出要有 agenda 数组（每条 key、title、startsAt），可以没有 items");
  }
}

type TryOut = SignalItem[] & { agenda?: { entries: unknown[] } };

async function tryOut(env: UiActionEnv, source: Pick<SignalSourceDto, "name" | "fetch" | "command">): Promise<TryOut> {
  const result = await serviceOf(env).collect(source);
  if (!result.ok) {
    throw new UiActionError(
      "invalid_input",
      `信号源没跑通：${result.error}。命令从环境变量 SIGNAL_INPUT 指的文件读输入（{results: [{connection, tool, text, data?}]}），`
        + "标准输出只能有一个 JSON 对象 {\"items\": [{\"key\", \"title\", \"text\", \"fields\"?, \"at\"?}]}。先在 bash 里把命令跑通",
    );
  }
  return Object.assign([...result.items], result.agenda ? { agenda: result.agenda } : {});
}

export const SIGNAL_SOURCES_TARGET: UiActionTargetKind<SignalSourcesTarget> = {
  type: "signal_sources",
  label: "信号源",
  idHint: "signals",
  load: (env, id) => (id === "signals" ? { sources: listSignalSources(env.db) } : null),
  name: () => "信号源",
  describe: (target) => ({
    sources: target.sources.map(sourceView),
    limits: { minEverySeconds: SIGNAL_SOURCE_LIMITS.minEverySeconds, maxItems: SIGNAL_SOURCE_LIMITS.maxItems, maxRules: SIGNAL_SOURCE_LIMITS.maxRules },
  }),
};

export const SIGNAL_SOURCES_ACTIONS = {
  create: {
    target: "signal_sources", id: "create", label: "建信号源", ...RULES,
    hint: "把一个连接接进事件体系：input.fetch 写定时调哪几个连接的只读工具（connection、tool、arguments），command 写把结果整理成条目的命令"
      + "（脚本放在你的工作目录里），rules 写用户说的哪些要马上告诉他（level now）、哪些进汇总（digest）、哪些不用管（ignore），"
      + "每句用用户的原话。policy 写用户说的能不能代他处理的原话；只有用户明确说了可以代他处理，才写 actForUser: true。"
      + "系统先试跑一次，跑通了才建。第一次定时运行只记基线，以后每条新内容交给你一个事件。"
      + "接日历、要会前提醒时，先建外部日程（agenda_feeds 的 create），再写 agendaFeed，命令输出 agenda 数组。先读 skill signal-sources。",
    defaultReason: "建了信号源",
    available: () => AVAILABLE,
    run: async (run) => {
      const input = run.input as SignalSourceInput;
      if (getSignalSource(run.db, input.name)) throw new UiActionError("invalid_input", `已经有信号源 ${input.name}：改它用 signal_source 的 update，或者换一个名字`);
      const items = await tryOut(run.env, input);
      checkAgendaFeed(run.env, input.agendaFeed, items);
      const source = createSignalSource(run.db, input, { by: run.by.actor === "lead" ? "lead" : "user", now: run.env.now });
      if (!source) throw new UiActionError("invalid_input", `已经有信号源 ${input.name}`);
      return { source, items };
    },
    forLead: (_run, result) => {
      const { source, items } = result as { source: SignalSourceDto; items: SignalItem[] };
      return {
        result: "created", source: sourceView(source), tryOut: shapeOf(items),
        next: "现在看到的内容算已有的，不会交给你；以后每条新内容一个事件。"
          + (source.actForUser
            ? "告诉用户：建好了，多久看一次，哪些会马上告诉他，以及你会按他说的代他处理。"
            : `告诉用户：建好了，多久看一次，哪些会马上告诉他，以及现在的缺省策略——${SIGNAL_DEFAULT_POLICY}`),
      };
    },
    detail: (_run, result) => {
      const { source } = result as { source: SignalSourceDto };
      return { name: source.name, fetch: source.fetch.map((fetch) => `${fetch.connection}.${fetch.tool}`), rules: source.rules.length, actForUser: source.actForUser };
    },
  },
  test: {
    target: "signal_sources", id: "test", label: "试跑信号源", scope: "tickets:create",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false, readOnly: true,
    where: WHERE,
    hint: "试跑一次：调连接、跑命令、看输出合不合格。什么都不写。结果只有条数和形状，没有内容。",
    defaultReason: "试跑了信号源",
    available: () => AVAILABLE,
    run: async (run) => ({ items: await tryOut(run.env, run.input as SignalSourceInput) }),
    forLead: (_run, result) => ({ result: "ok", tryOut: shapeOf((result as { items: SignalItem[] }).items) }),
  },
} satisfies Record<string, UiActionDefinition<SignalSourcesTarget, any>>;

export const SIGNAL_SOURCE_TARGET: UiActionTargetKind<SignalSourceDto> = {
  type: "signal_source",
  label: "一个信号源",
  idHint: "信号源的名字（signal_sources 目标的 sources 里的 name）",
  load: (env, id) => getSignalSource(env.db, id),
  name: (source) => source.label,
  describe: sourceView,
};

function changed(run: { db: UiActionEnv["db"]; target: SignalSourceDto }, patch: Parameters<typeof updateSignalSource>[2]): SignalSourceDto {
  const next = updateSignalSource(run.db, run.target.name, patch);
  if (!next) throw new UiActionError("not_found", `信号源 ${run.target.name} 已经不在了`);
  return next;
}

export const SIGNAL_SOURCE_ACTIONS = {
  update: {
    target: "signal_source", id: "update", label: "改信号源", ...RULES,
    hint: "改规则（rules，整份替换，每句用用户的原话）、策略（policy、actForUser：只有用户明确说了可以代他处理才写 true）、间隔、名字、"
      + "命令或者调哪些连接工具。改了命令或者工具时系统先试跑一次，下一次运行重新记基线。",
    defaultReason: "改了信号源",
    available: () => AVAILABLE,
    run: async (run) => {
      const input = run.input as SignalSourceUpdate;
      const reshaped = input.fetch !== undefined || input.command !== undefined;
      const feed = input.agendaFeed === undefined ? run.target.agendaFeed : input.agendaFeed;
      if (reshaped || (input.agendaFeed !== undefined && input.agendaFeed !== null)) {
        const tried = await tryOut(run.env, { name: run.target.name, fetch: input.fetch ?? run.target.fetch, command: input.command ?? run.target.command });
        checkAgendaFeed(run.env, feed, tried);
      }
      // 间隔变了：下一次运行从上一次运行的时刻按新的间隔重排（没跑过的马上到点）。不改时下一次还按旧的间隔排着。
      const respaced = input.everySeconds !== undefined && input.everySeconds !== run.target.everySeconds;
      const lastRun = run.target.lastRunAt ? Date.parse(run.target.lastRunAt) : null;
      return changed(run, {
        label: input.label, fetch: input.fetch, command: input.command, everySeconds: input.everySeconds,
        rules: input.rules, policy: input.policy, actForUser: input.actForUser,
        ...(input.agendaFeed !== undefined ? { agendaFeed: input.agendaFeed } : {}),
        ...(respaced ? { nextRunAt: new Date(lastRun === null ? run.env.now.getTime() : lastRun + input.everySeconds! * 1000).toISOString() } : {}),
        ...(reshaped ? { baselinedAt: null, nextRunAt: run.env.now.toISOString() } : {}),
      });
    },
    forLead: (run, result) => ({
      result: "updated", source: sourceView(result as SignalSourceDto),
      ...((run.input as SignalSourceUpdate).actForUser !== undefined || (run.input as SignalSourceUpdate).policy !== undefined
        ? { next: "告诉用户现在的策略是什么。" } : {}),
    }),
    detail: (run) => ({ name: run.target.name, changed: Object.keys(run.input as SignalSourceUpdate) }),
  },
  pause: {
    target: "signal_source", id: "pause", label: "暂停信号源", ...RULES,
    hint: "暂停：不再定时跑，配置留着。用户说先别看了时用。",
    defaultReason: "暂停了信号源",
    available: (source) => (source.enabled ? AVAILABLE : { available: false, reason: "它已经暂停了" }),
    run: (run) => changed(run, { enabled: false }),
    forLead: (_run, result) => ({ result: "paused", source: sourceView(result as SignalSourceDto) }),
    detail: (run) => ({ name: run.target.name }),
  },
  resume: {
    target: "signal_source", id: "resume", label: "恢复信号源", ...RULES,
    hint: "恢复：接着定时跑，连续出错的次数清零，马上到点。系统因为连续出错暂停了它、你修好以后用。",
    defaultReason: "恢复了信号源",
    available: (source) => (source.enabled ? { available: false, reason: "它没有暂停" } : AVAILABLE),
    run: (run) => changed(run, { enabled: true, nextRunAt: run.env.now.toISOString() }),
    forLead: (_run, result) => ({ result: "resumed", source: sourceView(result as SignalSourceDto) }),
    detail: (run) => ({ name: run.target.name }),
  },
  run: {
    target: "signal_source", id: "run", label: "马上跑一次", scope: "tickets:create",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: WHERE,
    hint: "马上跑一次，不等到点。新内容照常变成事件交给你。暂停了的也能跑。",
    defaultReason: "马上跑了一次信号源",
    available: () => AVAILABLE,
    run: async (run) => {
      const result = await serviceOf(run.env).runNow(run.target.name);
      if (!result.ok) throw new UiActionError("unavailable", `这一次没跑通：${result.error}`);
      return result;
    },
    forLead: (_run, result) => ({ result: "ran", emitted: (result as { emitted: number }).emitted }),
    detail: (run, result) => ({ name: run.target.name, emitted: (result as { emitted: number }).emitted }),
  },
  delete: {
    target: "signal_source", id: "delete", label: "删信号源", ...RULES,
    hint: "删掉这个信号源：不再跑，配置不留。它以前交来的事件留着。用户说不要了时用；只是先停一下用 pause。",
    defaultReason: "删了信号源",
    available: () => AVAILABLE,
    run: (run) => {
      deleteSignalSource(run.db, run.target.name);
      return { name: run.target.name };
    },
    forLead: (run) => ({ result: "deleted", name: run.target.name }),
    detail: (run) => ({ name: run.target.name }),
  },
} satisfies Record<string, UiActionDefinition<SignalSourceDto, any>>;
