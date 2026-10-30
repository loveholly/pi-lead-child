// 控件的数据源（第二期，.scratch/custom-views/spec.md D3、D4）。daemon 每次轮询（3 秒）调一次 tick：挑出到点、没在跑、
// 没暂停的数据源，在 Lead 的 bash 沙箱里跑它的命令（和后台检查的命令检查同一个沙箱），用输出解析控件的模板，
// 合格了写进控件，推 snapshot.required（resource=widgets）。跑数据源不叫醒 Lead、不花 token（用户 2026-10-30：
// 「不是一个固定的脚本，然后搭配一个状态绑定就能自动更新 UI 吗」）。
//
// 出错（命令失败、超时、输出不是 JSON、数据里缺字段、解析出来的卡不合格）时控件留着上一次的内容，记下原因；
// 连续出错 WIDGET_SOURCE_LIMITS.maxConsecutiveErrors 次就暂停，写一条叫醒 Lead 的 inbox（只这一次）。
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
  buildWidgetSurface, parseWidgetSourceOutput, resolveWidgetTemplate, WIDGET_SOURCE_LIMITS, WIDGETS_RESOURCE,
  type UiSurface, type WidgetSurfaceInput,
} from "@pi-lead-child/protocol";
import {
  addInbox, dueWidgetSources, finishWidgetSourceRun, getWidget, publishGatewayEvent, recoverWidgetSources, startWidgetSourceRun,
  type Db, type FinishedWidgetSourceRun, type WidgetSource,
} from "@pi-lead-child/store";

export interface WidgetCommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

/** 跑一条命令（daemon 里是 Lead 的 bash 沙箱）。跑不起来时抛错。 */
export type WidgetCommandRunner = (command: string, timeoutSeconds: number) => Promise<WidgetCommandResult>;

export type WidgetOutputResult = { ok: true; surface: UiSurface; data: Record<string, unknown> } | { ok: false; error: string };

/** 一次命令的结果变成控件的 surface：退出码、JSON、模板的绑定、和 render_ui 同一个校验，任何一步不行都给原因。 */
export function widgetSurfaceFromRun(widgetId: number, template: WidgetSurfaceInput, result: WidgetCommandResult): WidgetOutputResult {
  if (result.timedOut) return { ok: false, error: `命令超过 ${WIDGET_SOURCE_LIMITS.timeoutSeconds} 秒，被停了` };
  if (result.exitCode !== 0) {
    const tail = result.output.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    return { ok: false, error: `命令退出码 ${result.exitCode ?? "未知"}${tail ? `：${tail}` : ""}` };
  }
  const parsed = parseWidgetSourceOutput(result.output);
  if (!parsed.ok) return parsed;
  const resolved = resolveWidgetTemplate(template, parsed.data);
  if (!resolved.ok) return resolved;
  const built = buildWidgetSurface(widgetId, resolved.input);
  if (!built.ok) return { ok: false, error: `用这次的数据画出来的卡不合格：${built.errors.map((error) => `${error.path} ${error.message}`).join("；")}` };
  return { ok: true, surface: built.surface, data: parsed.data };
}

/** 跑一次命令并解析（建控件、改数据源时先跑一次用它；执行器每一次也用它）。命令跑不起来也算出错。 */
export async function runWidgetSource(
  run: WidgetCommandRunner, widgetId: number, template: WidgetSurfaceInput, command: string,
): Promise<WidgetOutputResult> {
  try {
    return widgetSurfaceFromRun(widgetId, template, await run(command, WIDGET_SOURCE_LIMITS.timeoutSeconds));
  } catch (error) {
    return { ok: false, error: `命令跑不起来：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 在 Lead 的 bash 沙箱里跑数据源的命令（和后台检查同一个沙箱、同一个工作目录）。输出最多留 4 倍上限：
 * 超过上限的输出整段算出错（parseWidgetSourceOutput 写原因），不截半截再去解析。
 */
export function sandboxWidgetCommand(operations: Pick<BashOperations, "exec">, cwd: string): WidgetCommandRunner {
  return async (command, timeoutSeconds) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (data: Buffer) => {
      if (size > WIDGET_SOURCE_LIMITS.outputBytes * 4) return;
      chunks.push(data);
      size += data.length;
    };
    try {
      const result = await operations.exec(command, cwd, { onData, timeout: timeoutSeconds });
      return { exitCode: result.exitCode, output: Buffer.concat(chunks).toString("utf8"), timedOut: false };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("timeout:")) return { exitCode: null, output: Buffer.concat(chunks).toString("utf8"), timedOut: true };
      throw error;
    }
  };
}

export interface WidgetSourceRunnerOptions {
  runCommand: WidgetCommandRunner;
  now?: () => Date;
  onError?: (step: string, error: unknown) => void;
}

export interface WidgetSourceRunner {
  // 开始到点的数据源。返回的 Promise 在这一拍开始的都跑完时完成（daemon 不等它，测试等它）。
  tick(): Promise<void>;
  // daemon 启动时：重启打断的那一次马上重跑。
  recover(): void;
}

function changed(db: Db, now: Date): void {
  publishGatewayEvent(db, { type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: WIDGETS_RESOURCE }, now });
}

// 连续出错到了上限：暂停，叫醒 Lead 一次（它可以修命令或模板，或者告诉用户）。
function wakeLeadForPause(db: Db, finished: FinishedWidgetSourceRun): void {
  const widget = getWidget(db, finished.source.widgetId);
  const title = widget ? `「${widget.title}」` : `#${finished.source.widgetId}`;
  addInbox(db, {
    dedupScope: `widget_source:${finished.source.widgetId}:paused:${finished.source.lastRunAt ?? ""}`,
    severity: "attention",
    source: "structural",
    summary: [
      `控件 ${title}（#${finished.source.widgetId}）的数据源连续出错 ${finished.source.consecutiveErrors} 次，已经暂停。`,
      `最后一次的原因：${finished.source.lastError ?? "未知"}`,
      "控件留着上一次成功的内容。修好命令或模板以后用 widget / update 换掉数据源，或者用 widget / refresh 再跑一次；修不了就告诉用户。",
    ].join("\n"),
    payload: { kind: "widget_source_paused", widget: finished.source.widgetId, wakeLead: true, needsUser: false },
    lossless: true,
  });
}

export function createWidgetSourceRunner(db: Db, opts: WidgetSourceRunnerOptions): WidgetSourceRunner {
  const now = opts.now ?? (() => new Date());
  const report = (step: string, error: unknown) => opts.onError?.(step, error);

  async function runOne(source: WidgetSource): Promise<void> {
    const result = await runWidgetSource(opts.runCommand, source.widgetId, source.template, source.command);
    const at = now();
    const finished = finishWidgetSourceRun(db, source.widgetId, result.ok ? { ok: true, surface: result.surface } : result, at);
    if (!finished) return;
    // 内容变了、出错了（页面要写原因）、从出错恢复了，都让页面重取；内容没变的成功不推。
    if (finished.surfaceChanged || !result.ok || source.lastError !== null) changed(db, at);
    if (finished.pausedNow) wakeLeadForPause(db, finished);
  }

  return {
    async tick(): Promise<void> {
      const started: Array<Promise<void>> = [];
      for (const source of dueWidgetSources(db, now())) {
        try {
          if (!startWidgetSourceRun(db, source.widgetId, now())) continue;
          started.push(runOne(source).catch((error) => report(`widget source #${source.widgetId}`, error)));
        } catch (error) {
          report(`widget source #${source.widgetId}`, error);
        }
      }
      await Promise.all(started);
    },
    recover(): void {
      recoverWidgetSources(db, now());
    },
  };
}
