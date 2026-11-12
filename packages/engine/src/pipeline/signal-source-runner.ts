// 信号源的执行器（protocol 的 signal-sources.ts，用户 2026-11-11、2026-11-12）。daemon 每次轮询调一次 tick：
// 挑出到点、没在跑的信号源，
//   1. 调它写明的那几个连接工具（只读的才调，不经过模型），
//   2. 把结果写进一个文件，在 Lead 的沙箱里跑它的命令（环境变量 SIGNAL_INPUT 指着那个文件），
//   3. 命令输出一个 JSON 对象 {items: [{key, title, text, at?, fields?}]}，
//   4. 没见过的每一条写一个事件 signal.received（来源 signal，按 信号源:key 去重）。
// 跑信号源不叫醒 Lead、不花 Lead 的 token；只有新内容的事件按级别交给 Lead。级别由便宜的模型按用户的那几句规则定
// （grade；没有规则、哪句都不像、模型不可用时不指定级别，交给分诊：外部来源缺省进汇总）。
// 第一次运行只记基线：那时看到的都是已有的内容，不是新来的，记成 record 级，不交给 Lead。
// 出错（连接调不通、工具不是只读、命令失败、输出不合格）时记下原因；连续出错 maxConsecutiveErrors 次就暂停，叫醒 Lead 一次。
// 这里不认识任何具体的来源：邮件、日历都是数据。
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENDA_FEED_LIMITS, SIGNAL_EVENT_LEVELS, SIGNAL_EVENT_SOURCE, SIGNAL_RECEIVED_KIND, SIGNAL_SOURCE_LIMITS,
  type AgendaSnapshot, type SignalItem, type SignalRule, type SignalSourceDto,
} from "@pi-lead-child/protocol";
import {
  addInbox, appendEvent, dueSignalSources, getAgendaFeed, getSignalSource, recordAgendaFeedError, recordSignalSourceRun,
  syncAgendaFeed, type Db,
} from "@pi-lead-child/store";

export interface SignalCommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

/** 跑一条命令（daemon 里是 Lead 的 bash 沙箱）。跑不起来时抛错。 */
export type SignalCommandRunner = (command: string, timeoutSeconds: number) => Promise<SignalCommandResult>;

/**
 * 在 Lead 的 bash 沙箱里跑命令（和控件的数据源同一个沙箱；这里的输出上限大：一次最多 50 条内容）。
 * 输出收到上限的两倍为止：再多的丢掉，解析时按超出上限报错。
 */
export function sandboxSignalCommand(operations: Pick<BashOperations, "exec">, cwd: string): SignalCommandRunner {
  return async (command, timeoutSeconds) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (data: Buffer) => {
      if (size > SIGNAL_SOURCE_LIMITS.outputBytes * 2) return;
      chunks.push(data);
      size += data.length;
    };
    try {
      const result = await operations.exec(command, cwd, { onData, timeout: timeoutSeconds });
      return { exitCode: result.exitCode, output: Buffer.concat(chunks).toString("utf8"), timedOut: false };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("timeout:")) {
        return { exitCode: null, output: Buffer.concat(chunks).toString("utf8"), timedOut: true };
      }
      throw error;
    }
  };
}

/** 调连接的工具（daemon 里是连接中心）。 */
export interface SignalConnectionCalls {
  // 这个连接现在用不了的原因（没有这个连接、授权失效、暂时连不上）。能用时为 null。不给时不查。
  problem?(connection: string): string | null;
  isReadOnly(connection: string, tool: string): boolean;
  call(connection: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export interface SignalGrade {
  rule: SignalRule | null;
  graded: "model" | "default" | "unavailable";
}

/** 这一条最像用户的哪一句规则（smart-model 判断，signal-grade.ts）。 */
export type SignalGrader = (source: SignalSourceDto, item: SignalItem) => Promise<SignalGrade>;

export interface SignalCollectDeps {
  connections: SignalConnectionCalls;
  runCommand: SignalCommandRunner;
  // 放输入文件的目录（Lead 的沙箱读得到的地方）。
  inputDir: string;
  now?: () => Date;
}

// agenda: the command's `agenda` output (entries are checked by the feed's sync), present only when the command gave one.
export type SignalCollectResult = { ok: true; items: SignalItem[]; agenda?: AgendaSnapshot } | { ok: false; error: string };

const shellQuote = (value: string): string => `'${value.replace(/'/gu, `'\\''`)}'`;
const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value);

function parseItems(output: string): SignalCollectResult {
  if (Buffer.byteLength(output) > SIGNAL_SOURCE_LIMITS.outputBytes) {
    return { ok: false, error: `命令的输出超过 ${SIGNAL_SOURCE_LIMITS.outputBytes} 字节：只输出最近的条目` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return { ok: false, error: `命令的输出不是 JSON：${clip(output.trim().replace(/\s+/gu, " "), 200) || "（空的）"}` };
  }
  const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  // An agenda feed's command may output only `agenda` (and `agendaComplete`); items then default to none.
  const agendaList = object?.agenda;
  if (agendaList !== undefined && !Array.isArray(agendaList)) return { ok: false, error: "agenda 要是一个数组" };
  if (Array.isArray(agendaList) && agendaList.length > AGENDA_FEED_LIMITS.maxEntries) {
    return { ok: false, error: `agenda 一次输出了 ${agendaList.length} 条，最多 ${AGENDA_FEED_LIMITS.maxEntries} 条：缩短同步窗口` };
  }
  const agenda: AgendaSnapshot | undefined = Array.isArray(agendaList)
    ? { entries: agendaList, ...(typeof object?.agendaComplete === "boolean" ? { complete: object.agendaComplete } : {}) }
    : undefined;
  const list = object?.items ?? (agenda ? [] : undefined);
  if (!Array.isArray(list)) return { ok: false, error: "命令的输出要是一个 JSON 对象，里面有 items 数组" };
  if (list.length > SIGNAL_SOURCE_LIMITS.maxItems) {
    return { ok: false, error: `一次输出了 ${list.length} 条，最多 ${SIGNAL_SOURCE_LIMITS.maxItems} 条：只输出最近的条目` };
  }
  const items: SignalItem[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of list.entries()) {
    const entry = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const key = typeof entry.key === "string" ? entry.key.trim() : typeof entry.key === "number" ? String(entry.key) : "";
    const title = typeof entry.title === "string" ? entry.title.trim() : "";
    if (!key || !title) return { ok: false, error: `items 的第 ${index + 1} 条缺 key 或 title` };
    if (key.length > SIGNAL_SOURCE_LIMITS.key) return { ok: false, error: `items 的第 ${index + 1} 条的 key 超过 ${SIGNAL_SOURCE_LIMITS.key} 个字` };
    if (seen.has(key)) continue;
    seen.add(key);
    const fields: Record<string, string | number | boolean> = {};
    if (entry.fields && typeof entry.fields === "object" && !Array.isArray(entry.fields)) {
      for (const [name, value] of Object.entries(entry.fields as Record<string, unknown>).slice(0, 20)) {
        if (typeof value === "string") fields[name] = clip(value, 300);
        else if (typeof value === "number" || typeof value === "boolean") fields[name] = value;
      }
    }
    const at = typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)) ? entry.at : undefined;
    items.push({
      key, title: clip(title, SIGNAL_SOURCE_LIMITS.title),
      text: clip(typeof entry.text === "string" ? entry.text : "", SIGNAL_SOURCE_LIMITS.text),
      ...(at ? { at } : {}), ...(Object.keys(fields).length ? { fields } : {}),
    });
  }
  return { ok: true, items, ...(agenda ? { agenda } : {}) };
}

/**
 * 跑一次：调连接、跑命令、解析条目。不写事件（建信号源以前的试跑、执行器每一次都用它）。
 * 任何一步不行都给原因，不抛错。
 */
export async function collectSignalItems(
  source: Pick<SignalSourceDto, "name" | "fetch" | "command">, deps: SignalCollectDeps,
): Promise<SignalCollectResult> {
  const results: Array<{ connection: string; tool: string; text: string; data?: unknown }> = [];
  for (const fetch of source.fetch) {
    // 连接现在用不了（授权失效、断开了）：写明原因。不先查的话，下面会把它说成「不是只读工具」。
    const problem = deps.connections.problem?.(fetch.connection) ?? null;
    if (problem) return { ok: false, error: `${fetch.connection} 现在用不了：${clip(problem, 300)}` };
    // 只读的才调：信号源是定时自己跑的，不能往外部账号里写。
    if (!deps.connections.isReadOnly(fetch.connection, fetch.tool)) {
      return { ok: false, error: `${fetch.connection} 的 ${fetch.tool} 不是只读工具（或者连接、工具不存在）：信号源只能调只读工具` };
    }
    let reply: { text: string; isError: boolean };
    try {
      reply = await deps.connections.call(fetch.connection, fetch.tool, fetch.arguments ?? {});
    } catch (error) {
      return { ok: false, error: `调 ${fetch.connection} 的 ${fetch.tool} 出错：${clip(error instanceof Error ? error.message : String(error), 300)}` };
    }
    if (reply.isError) return { ok: false, error: `${fetch.connection} 的 ${fetch.tool} 返回了错误：${clip(reply.text, 300)}` };
    let data: unknown;
    try { data = JSON.parse(reply.text); } catch { data = undefined; }
    results.push({ connection: fetch.connection, tool: fetch.tool, text: reply.text, ...(data === undefined ? {} : { data }) });
  }
  const inputPath = join(deps.inputDir, `${source.name}.input.json`);
  try {
    mkdirSync(deps.inputDir, { recursive: true, mode: 0o700 });
    writeFileSync(inputPath, JSON.stringify({ source: source.name, fetchedAt: (deps.now?.() ?? new Date()).toISOString(), results }), { mode: 0o600 });
  } catch (error) {
    return { ok: false, error: `写输入文件出错：${error instanceof Error ? error.message : String(error)}` };
  }
  let run: SignalCommandResult;
  try {
    run = await deps.runCommand(`SIGNAL_INPUT=${shellQuote(inputPath)} ${source.command}`, SIGNAL_SOURCE_LIMITS.timeoutSeconds);
  } catch (error) {
    return { ok: false, error: `命令跑不起来：${error instanceof Error ? error.message : String(error)}` };
  }
  if (run.timedOut) return { ok: false, error: `命令超过 ${SIGNAL_SOURCE_LIMITS.timeoutSeconds} 秒，被停了` };
  if (run.exitCode !== 0) {
    const tail = run.output.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    return { ok: false, error: `命令退出码 ${run.exitCode ?? "未知"}${tail ? `：${tail}` : ""}` };
  }
  return parseItems(run.output);
}

export interface SignalSourceRunnerOptions extends SignalCollectDeps {
  grade?: SignalGrader;
  onError?: (step: string, error: unknown) => void;
}

export interface SignalSourceRunner {
  // 开始到点的信号源。返回的 Promise 在这一拍开始的都跑完时完成（daemon 不等它，测试等它）。
  tick(): Promise<void>;
  // 马上跑一次（不管到没到点）。返回这一次新写了几个事件，或者出错的原因。
  runNow(name: string): Promise<{ ok: true; emitted: number } | { ok: false; error: string }>;
}

const sourceRefOf = (name: string, key: string): string => `${name}:${key}`;

function alreadySeen(db: Db, name: string, key: string): boolean {
  return db.prepare("SELECT 1 FROM events WHERE source = ? AND source_ref = ?").get(SIGNAL_EVENT_SOURCE, sourceRefOf(name, key)) !== undefined;
}

// 连续出错到了上限：暂停，叫醒 Lead 一次（它可以修命令，或者告诉用户）。
function wakeLeadForPause(db: Db, source: SignalSourceDto): void {
  addInbox(db, {
    dedupScope: `signal_source:${source.name}:paused:${source.lastRunAt ?? ""}`,
    severity: "attention",
    source: "structural",
    summary: [
      `信号源「${source.label}」（${source.name}）连续出错 ${source.consecutiveErrors} 次，已经暂停。`,
      `最后一次的原因：${source.lastError ?? "未知"}`,
      "修好以后用 perform_action(target_type='signal_source'，action='resume') 恢复；修不了就告诉用户。",
    ].join("\n"),
    payload: { kind: "signal_source_paused", signal: source.name, wakeLead: true, needsUser: false },
    lossless: true,
  });
}

export function createSignalSourceRunner(db: Db, options: SignalSourceRunnerOptions): SignalSourceRunner {
  const now = options.now ?? (() => new Date());
  const running = new Set<string>();

  async function runOne(source: SignalSourceDto): Promise<{ ok: true; emitted: number } | { ok: false; error: string }> {
    const collected = await collectSignalItems(source, options);
    const at = now();
    if (!collected.ok) {
      const recorded = recordSignalSourceRun(db, source.name, { ok: false, error: collected.error }, at);
      if (recorded?.paused) wakeLeadForPause(db, recorded.source);
      return collected;
    }
    // An agenda feed takes the whole snapshot on every run, the first one included: reminders for meetings that are
    // already on the calendar are what the user wants. A feed that went away, or output without `agenda`, is a run error.
    if (source.agendaFeed !== null) {
      const problem = !getAgendaFeed(db, source.agendaFeed)
        ? `外部日程 ${source.agendaFeed} 不在了：建它（agenda_feeds 的 create），或者把信号源的 agendaFeed 改成 null`
        : !collected.agenda ? "这个信号源接着外部日程，命令的输出要有 agenda 数组" : null;
      if (problem) {
        recordAgendaFeedError(db, source.agendaFeed, problem, at);
        const recorded = recordSignalSourceRun(db, source.name, { ok: false, error: problem }, at);
        if (recorded?.paused) wakeLeadForPause(db, recorded.source);
        return { ok: false, error: problem };
      }
      syncAgendaFeed(db, source.agendaFeed, collected.agenda!, at);
    }
    // 第一次成功的运行：看到的都是已有的内容，只记基线。
    const baseline = source.baselinedAt === null;
    let emitted = 0;
    for (const item of collected.items) {
      if (alreadySeen(db, source.name, item.key)) continue;
      let grade: SignalGrade = { rule: null, graded: "default" };
      if (!baseline && source.rules.length && options.grade) {
        try {
          grade = await options.grade(source, item);
        } catch (error) {
          options.onError?.(`grade ${source.name}`, error);
          grade = { rule: null, graded: "unavailable" };
        }
      }
      // 写的时候信号源可能已经被删了：不再写它的事件。
      const live = getSignalSource(db, source.name);
      if (!live) break;
      const level = baseline ? "record" : grade.rule ? SIGNAL_EVENT_LEVELS[grade.rule.level] : undefined;
      const result = db.transaction(() => appendEvent(db, {
        source: SIGNAL_EVENT_SOURCE, sourceRef: sourceRefOf(source.name, item.key), kind: SIGNAL_RECEIVED_KIND,
        entityKey: `signal:${source.name}`, ...(item.at ? { occurredAt: item.at } : {}), ...(level ? { level } : {}),
        payload: {
          signal: source.name, label: live.label, key: item.key, title: item.title, text: item.text,
          ...(item.fields ? { fields: item.fields } : {}),
          rule: grade.rule ? { text: grade.rule.text, level: grade.rule.level } : null,
          graded: grade.graded, actForUser: live.actForUser, policy: live.policy,
          // 摘要里不放标题：标题是别人写的话，摘要会出现在外部标签以外的地方（当前局面、通用的事件块）。
          summary: `${live.label} 有一条新内容`,
        },
      }, { receivedAt: at }))();
      if (result.inserted) emitted++;
    }
    recordSignalSourceRun(db, source.name, { ok: true, emitted }, at);
    return { ok: true, emitted };
  }

  async function guarded(source: SignalSourceDto): Promise<{ ok: true; emitted: number } | { ok: false; error: string }> {
    if (running.has(source.name)) return { ok: false, error: "这个信号源正在跑" };
    running.add(source.name);
    try {
      return await runOne(source);
    } catch (error) {
      options.onError?.(`run ${source.name}`, error);
      const message = error instanceof Error ? error.message : String(error);
      try {
        const recorded = recordSignalSourceRun(db, source.name, { ok: false, error: message }, now());
        if (recorded?.paused) wakeLeadForPause(db, recorded.source);
      } catch (inner) {
        options.onError?.(`record ${source.name}`, inner);
      }
      return { ok: false, error: message };
    } finally {
      running.delete(source.name);
    }
  }

  return {
    async tick() {
      const due = dueSignalSources(db, now()).filter((source) => !running.has(source.name));
      await Promise.all(due.map((source) => guarded(source)));
    },
    async runNow(name) {
      const source = getSignalSource(db, name);
      if (!source) return { ok: false, error: `没有信号源 ${name}` };
      return guarded(source);
    },
  };
}
