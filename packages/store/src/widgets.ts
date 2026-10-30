// 自定义控件（.scratch/custom-views/spec.md D1）的读写。视图面板里的一块：标题、所在的视图、一块校验过的 genui surface。
// 校验在 engine 的操作里做（protocol 的 buildWidgetSurface），这里只存和读。position 越小越靠上，新控件排在最上面。
// 视图只是控件的一个属性（缺省 default）：没有单独的表，一个视图里没有控件了，它就不在了。
import {
  DEFAULT_VIEW, WIDGET_LIMITS, WIDGET_SOURCE_LIMITS, widgetSurfaceId,
  type UiSurface, type WidgetActor, type WidgetDto, type WidgetSourceDto, type WidgetSurfaceInput,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

interface WidgetRow {
  id: number;
  title: string;
  view: string;
  surface: string;
  position: number;
  created_by: WidgetActor;
  created_at: string;
  updated_at: string;
}

export class WidgetStoreError extends Error {
  constructor(readonly code: "limit" | "not_found" | "invalid", message: string) {
    super(message);
  }
}

interface WidgetSourceRow {
  widget_id: number;
  template: string;
  command: string;
  every_seconds: number;
  next_run_at: string | null;
  running_since: string | null;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  consecutive_errors: number;
  paused: 0 | 1;
}

function sourceDto(row: WidgetSourceRow | undefined): WidgetSourceDto | null {
  if (!row) return null;
  return {
    everySeconds: row.every_seconds, lastRunAt: row.last_run_at, lastOkAt: row.last_ok_at, lastError: row.last_error, paused: row.paused === 1,
  };
}

function toDto(row: WidgetRow, source: WidgetSourceRow | undefined): WidgetDto {
  // surface 的 id 跟着控件编号（建控件时还不知道编号）。
  const surface = { ...(JSON.parse(row.surface) as UiSurface), id: widgetSurfaceId(row.id) };
  return {
    id: row.id, title: row.title, view: row.view, surface, source: sourceDto(source),
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** 全部控件，按面板里从上到下的顺序。 */
export function listWidgets(db: Db): WidgetDto[] {
  const rows = db.prepare("SELECT * FROM widgets ORDER BY position, id").all() as WidgetRow[];
  const sources = new Map((db.prepare("SELECT * FROM widget_sources").all() as WidgetSourceRow[]).map((row) => [row.widget_id, row]));
  return rows.map((row) => toDto(row, sources.get(row.id)));
}

export function getWidget(db: Db, id: number): WidgetDto | null {
  const row = db.prepare("SELECT * FROM widgets WHERE id = ?").get(id) as WidgetRow | undefined;
  return row ? toDto(row, sourceRow(db, id)) : null;
}

function sourceRow(db: Db, widgetId: number): WidgetSourceRow | undefined {
  return db.prepare("SELECT * FROM widget_sources WHERE widget_id = ?").get(widgetId) as WidgetSourceRow | undefined;
}

export function countWidgets(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM widgets").get() as { n: number }).n;
}

/** 现有的视图名（不排序）。 */
function viewNames(db: Db): Set<string> {
  return new Set((db.prepare("SELECT DISTINCT view FROM widgets").all() as { view: string }[]).map((row) => row.view));
}

// 把一个控件放进 view 以后视图会不会超过上限（view 已经有了时不会）。
function checkViewLimit(db: Db, view: string): void {
  const views = viewNames(db);
  if (!views.has(view) && views.size >= WIDGET_LIMITS.views) {
    throw new WidgetStoreError("limit", `已经有 ${WIDGET_LIMITS.views} 个视图了，放进已有的视图，或者先把一个视图里的控件删完`);
  }
}

/**
 * 建一个控件，排在最上面。surfaceFor 拿到新控件的编号，返回它的 surface（编号写进 surface 的 id）。
 * 已经有 WIDGET_LIMITS.widgets 个控件，或者要开新视图而视图已经到上限时拒绝。
 */
export function createWidget(
  db: Db,
  input: { title: string; view?: string; createdBy: WidgetActor; now?: Date },
  surfaceFor: (id: number) => UiSurface,
): WidgetDto {
  return db.transaction(() => {
    if (countWidgets(db) >= WIDGET_LIMITS.widgets) {
      throw new WidgetStoreError("limit", `已经有 ${WIDGET_LIMITS.widgets} 个控件了，先删掉不用的`);
    }
    const view = input.view ?? DEFAULT_VIEW;
    checkViewLimit(db, view);
    const at = (input.now ?? new Date()).toISOString();
    const top = (db.prepare("SELECT MIN(position) AS p FROM widgets").get() as { p: number | null }).p;
    const { lastInsertRowid } = db.prepare(
      "INSERT INTO widgets (title, view, surface, position, created_by, created_at, updated_at) VALUES (?, ?, '{}', ?, ?, ?, ?)",
    ).run(input.title, view, top === null ? 0 : top - 1, input.createdBy, at, at);
    const id = Number(lastInsertRowid);
    db.prepare("UPDATE widgets SET surface = ? WHERE id = ?").run(JSON.stringify(surfaceFor(id)), id);
    return getWidget(db, id)!;
  })();
}

/** 改标题、surface、所在的视图。控件不在时返回 null。 */
export function updateWidget(
  db: Db,
  id: number,
  change: { title?: string; surface?: UiSurface; view?: string; now?: Date },
): WidgetDto | null {
  return db.transaction(() => {
    const current = getWidget(db, id);
    if (!current) return null;
    if (change.view !== undefined && change.view !== current.view) checkViewLimit(db, change.view);
    const at = (change.now ?? new Date()).toISOString();
    db.prepare(
      "UPDATE widgets SET title = COALESCE(?, title), view = COALESCE(?, view), surface = COALESCE(?, surface), updated_at = ? WHERE id = ?",
    ).run(change.title ?? null, change.view ?? null, change.surface ? JSON.stringify(change.surface) : null, at, id);
    return getWidget(db, id);
  })();
}

/** 删掉一个控件。返回删掉的那个；不在时返回 null。 */
export function deleteWidget(db: Db, id: number): WidgetDto | null {
  return db.transaction(() => {
    const widget = getWidget(db, id);
    if (!widget) return null;
    db.prepare("DELETE FROM widget_sources WHERE widget_id = ?").run(id);
    db.prepare("DELETE FROM widgets WHERE id = ?").run(id);
    return widget;
  })();
}

/** 按给的顺序重排。ids 必须正好是现有的全部控件，不多不少、不重复。 */
export function reorderWidgets(db: Db, ids: readonly number[], now = new Date()): WidgetDto[] {
  return db.transaction(() => {
    const existing = new Set(listWidgets(db).map((widget) => widget.id));
    if (new Set(ids).size !== ids.length || ids.length !== existing.size || ids.some((id) => !existing.has(id))) {
      throw new WidgetStoreError("invalid", "顺序要正好列出现有的全部控件，每个一次");
    }
    const at = now.toISOString();
    const move = db.prepare("UPDATE widgets SET position = ?, updated_at = ? WHERE id = ?");
    ids.forEach((id, position) => move.run(position, at, id));
    return listWidgets(db);
  })();
}

/** 视图改名：view 里的控件都换到 name 下。name 已经有了时两个视图合成一个。返回改了几个控件；没有这个视图时拒绝。 */
export function renameView(db: Db, view: string, name: string, now = new Date()): number {
  return db.transaction(() => {
    if (!viewNames(db).has(view)) throw new WidgetStoreError("not_found", `没有叫「${view}」的视图`);
    const { changes } = db.prepare("UPDATE widgets SET view = ?, updated_at = ? WHERE view = ?").run(name, now.toISOString(), view);
    return changes;
  })();
}

// ── 数据源（第二期，spec D3）────────────────────────────────────────────────────────────

/** 数据源的全部设置（daemon 和操作层用）：命令、模板、间隔和现在的状态。 */
export interface WidgetSource {
  widgetId: number;
  template: WidgetSurfaceInput;
  command: string;
  everySeconds: number;
  nextRunAt: string | null;
  runningSince: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  paused: boolean;
}

function toSource(row: WidgetSourceRow): WidgetSource {
  return {
    widgetId: row.widget_id, template: JSON.parse(row.template) as WidgetSurfaceInput, command: row.command,
    everySeconds: row.every_seconds, nextRunAt: row.next_run_at, runningSince: row.running_since, lastRunAt: row.last_run_at,
    lastOkAt: row.last_ok_at, lastError: row.last_error, consecutiveErrors: row.consecutive_errors, paused: row.paused === 1,
  };
}

export function getWidgetSource(db: Db, widgetId: number): WidgetSource | null {
  const row = sourceRow(db, widgetId);
  return row ? toSource(row) : null;
}

const later = (at: Date, seconds: number) => new Date(at.getTime() + seconds * 1000).toISOString();

/**
 * 给控件设数据源（或者换掉原来的）：模板、命令、间隔。设的时候操作层已经用这条命令跑过一次、解析过模板，
 * 所以这一次算成功：清掉出错和暂停，下一次在 everySeconds 以后。
 */
export function setWidgetSource(
  db: Db, widgetId: number, input: { template: WidgetSurfaceInput; command: string; everySeconds: number; now?: Date },
): WidgetSource {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  db.prepare(
    `INSERT INTO widget_sources (widget_id, template, command, every_seconds, next_run_at, last_run_at, last_ok_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(widget_id) DO UPDATE SET template = excluded.template, command = excluded.command, every_seconds = excluded.every_seconds,
       next_run_at = excluded.next_run_at, running_since = NULL, last_run_at = excluded.last_run_at, last_ok_at = excluded.last_ok_at,
       last_error = NULL, consecutive_errors = 0, paused = 0, updated_at = excluded.updated_at`,
  ).run(widgetId, JSON.stringify(input.template), input.command, input.everySeconds, later(now, input.everySeconds), at, at, at, at);
  return getWidgetSource(db, widgetId)!;
}

/** 只换模板（命令和间隔不变）。调用方已经用最新的数据解析过它。 */
export function setWidgetTemplate(db: Db, widgetId: number, template: WidgetSurfaceInput, now = new Date()): void {
  db.prepare("UPDATE widget_sources SET template = ?, updated_at = ? WHERE widget_id = ?").run(JSON.stringify(template), now.toISOString(), widgetId);
}

/** 去掉数据源：控件停在最后一次的内容上，变回快照。返回原来有没有。 */
export function clearWidgetSource(db: Db, widgetId: number): boolean {
  return db.prepare("DELETE FROM widget_sources WHERE widget_id = ?").run(widgetId).changes > 0;
}

/** 到点、没在跑、没暂停的数据源。 */
export function dueWidgetSources(db: Db, now = new Date()): WidgetSource[] {
  const rows = db.prepare(
    "SELECT * FROM widget_sources WHERE paused = 0 AND running_since IS NULL AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY next_run_at, widget_id",
  ).all(now.toISOString()) as WidgetSourceRow[];
  return rows.map(toSource);
}

/** 记下开始跑。别人已经在跑、或者暂停了、或者没有了时返回 false。 */
export function startWidgetSourceRun(db: Db, widgetId: number, now = new Date()): boolean {
  return db.prepare("UPDATE widget_sources SET running_since = ? WHERE widget_id = ? AND running_since IS NULL AND paused = 0")
    .run(now.toISOString(), widgetId).changes > 0;
}

/** 这一次跑完的结果：成功时带上解析好的 surface（写进控件），出错时带原因。 */
export type WidgetSourceOutcome = { ok: true; surface: UiSurface } | { ok: false; error: string };

export interface FinishedWidgetSourceRun {
  source: WidgetSource;
  // 控件的内容变了（成功而且 surface 和原来不一样）。
  surfaceChanged: boolean;
  // 这一次让它暂停了（连续出错到了上限）。
  pausedNow: boolean;
}

/** 记下这一次跑的结果，排好下一次。数据源这时已经没了（被删、被去掉）时返回 null。 */
export function finishWidgetSourceRun(db: Db, widgetId: number, outcome: WidgetSourceOutcome, now = new Date()): FinishedWidgetSourceRun | null {
  return db.transaction(() => {
    const row = sourceRow(db, widgetId);
    if (!row) return null;
    const at = now.toISOString();
    const next = later(now, row.every_seconds);
    if (outcome.ok) {
      const before = (db.prepare("SELECT surface FROM widgets WHERE id = ?").get(widgetId) as { surface: string } | undefined)?.surface;
      const after = JSON.stringify(outcome.surface);
      const surfaceChanged = before !== after;
      if (surfaceChanged) db.prepare("UPDATE widgets SET surface = ? WHERE id = ?").run(after, widgetId);
      db.prepare(
        `UPDATE widget_sources SET running_since = NULL, last_run_at = ?, last_ok_at = ?, last_error = NULL, consecutive_errors = 0,
           next_run_at = ? WHERE widget_id = ?`,
      ).run(at, at, next, widgetId);
      return { source: getWidgetSource(db, widgetId)!, surfaceChanged, pausedNow: false };
    }
    const errors = row.consecutive_errors + 1;
    const pausedNow = errors >= WIDGET_SOURCE_LIMITS.maxConsecutiveErrors;
    db.prepare(
      `UPDATE widget_sources SET running_since = NULL, last_run_at = ?, last_error = ?, consecutive_errors = ?, paused = ?,
         next_run_at = ? WHERE widget_id = ?`,
    ).run(at, outcome.error.slice(0, 500), errors, pausedNow ? 1 : 0, pausedNow ? null : next, widgetId);
    return { source: getWidgetSource(db, widgetId)!, surfaceChanged: false, pausedNow };
  })();
}

/** 马上再跑一次：下一次排到现在，暂停了的也接着跑（出错的次数从头算）。没有数据源时返回 false。 */
export function requestWidgetRefresh(db: Db, widgetId: number, now = new Date()): boolean {
  return db.prepare(
    "UPDATE widget_sources SET next_run_at = ?, paused = 0, consecutive_errors = CASE WHEN paused = 1 THEN 0 ELSE consecutive_errors END WHERE widget_id = ?",
  ).run(now.toISOString(), widgetId).changes > 0;
}

/** daemon 启动时：重启打断的那一次不算，马上重跑。返回放回去了几个。 */
export function recoverWidgetSources(db: Db, now = new Date()): number {
  return db.prepare("UPDATE widget_sources SET running_since = NULL, next_run_at = ? WHERE running_since IS NOT NULL").run(now.toISOString()).changes;
}
