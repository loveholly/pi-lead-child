// 控件的数据源（第二期，.scratch/custom-views/spec.md D3、D4；用户 2026-10-30：「不是一个固定的脚本，然后搭配一个状态绑定
// 就能自动更新 UI 吗，为什么需要 lead 介入它的更新」）。daemon 按间隔跑命令，用输出解析带 {"$data": …} 绑定的模板，
// 合格了写进控件，不叫醒 Lead。出错时控件留着上一次的内容；连续出错 5 次暂停，叫醒 Lead 一次。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { parseWidgetSourceOutput, resolveWidgetTemplate, WIDGET_SOURCE_LIMITS, type WidgetDto } from "@pi-lead-child/protocol";
import { getWidget, getWidgetSource, listInbox, openDb, type Db } from "@pi-lead-child/store";
import {
  createWidgetSourceRunner, listLeadUiActions, runUiAction, type WidgetCommandResult, type WidgetCommandRunner,
} from "../src/index.js";

let db: Db;
let clock: Date;
let outputs: Array<WidgetCommandResult | Error>;
let commands: string[];
const user = { kind: "user" } as const;
const board = { type: "widget_board", id: "widgets" } as const;

// 假的沙箱：按顺序返回准备好的输出，记下跑过的命令。
const fakeRun: WidgetCommandRunner = async (command) => {
  commands.push(command);
  const next = outputs.shift() ?? { exitCode: 0, output: JSON.stringify({ price: "18,532", change: "+1.2%", tone: "success" }), timedOut: false };
  if (next instanceof Error) throw next;
  return next;
};
const json = (data: unknown): WidgetCommandResult => ({ exitCode: 0, output: JSON.stringify(data), timedOut: false });
const services = () => ({ widgetCommands: fakeRun });
const reloads = () => db.prepare("SELECT payload FROM gateway_events WHERE event_type = 'snapshot.required'").all()
  .map((row: any) => JSON.parse(row.payload)).filter((payload) => payload.resource === "widgets").length;

beforeEach(() => {
  db = openDb(join(tempDir("plc-widget-sources-"), "plc.db"));
  clock = new Date("2026-10-30T08:00:00.000Z");
  outputs = [];
  commands = [];
});

const template = {
  root: "tile",
  nodes: [{ id: "tile", type: "Tile", props: { eyebrow: "纳斯达克", value: { $data: "price" }, caption: "{{change}}", tone: { $data: "tone" } } }],
  fallback_text: "纳斯达克 {{price}}（{{change}}）",
};
const source = { command: "nasdaq.sh", every_seconds: 900 };

async function createNasdaq(): Promise<WidgetDto> {
  const outcome = await runUiAction(db, {
    target: board, action: "create", input: { title: "纳斯达克", surface: template, source }, caller: user, now: clock, services: services(),
  });
  return outcome.result as WidgetDto;
}

describe("data source output and template binding", () => {
  it("reads one JSON object, or the last line when something was printed before it", () => {
    expect(parseWidgetSourceOutput('{"a":1}')).toEqual({ ok: true, data: { a: 1 } });
    expect(parseWidgetSourceOutput('fetching…\n{"a":2}\n')).toEqual({ ok: true, data: { a: 2 } });
    expect(parseWidgetSourceOutput("[1,2]")).toMatchObject({ ok: false, error: expect.stringContaining("JSON 对象") });
    expect(parseWidgetSourceOutput("oops")).toMatchObject({ ok: false, error: expect.stringContaining("不是 JSON") });
    expect(parseWidgetSourceOutput("")).toMatchObject({ ok: false, error: "命令没有输出" });
    expect(parseWidgetSourceOutput(JSON.stringify({ x: "y".repeat(WIDGET_SOURCE_LIMITS.outputBytes) }))).toMatchObject({ ok: false });
  });

  it("replaces whole values and text placeholders by dot paths, and names the missing fields", () => {
    const bars = { root: "b", nodes: [{ id: "b", type: "BarChart", props: { bars: { $data: "series" }, unit: "{{unit}}" } }], fallback_text: "第一天 {{series.0.value}}" };
    const resolved = resolveWidgetTemplate(bars, { series: [{ label: "10-29", value: 1 }], unit: "点" });
    expect(resolved).toEqual({
      ok: true,
      input: { root: "b", nodes: [{ id: "b", type: "BarChart", props: { bars: [{ label: "10-29", value: 1 }], unit: "点" } }], fallback_text: "第一天 1" },
    });
    expect(resolveWidgetTemplate(template, { price: "1" })).toEqual({ ok: false, error: "数据里没有 change、tone" });
  });
});

describe("widgets with a data source", () => {
  it("runs the command once on create, shows the resolved card, and keeps the template and schedule", async () => {
    const widget = await createNasdaq();
    expect(commands).toEqual(["nasdaq.sh"]);
    expect(widget.surface).toMatchObject({
      id: `widget_${widget.id}`, fallbackText: "纳斯达克 18,532（+1.2%）",
      nodes: [{ props: { value: "18,532", caption: "+1.2%", tone: "success" } }],
    });
    expect(widget.source).toEqual({ everySeconds: 900, lastRunAt: clock.toISOString(), lastOkAt: clock.toISOString(), lastError: null, paused: false });
    expect(getWidgetSource(db, widget.id)).toMatchObject({ command: "nasdaq.sh", template, nextRunAt: "2026-10-30T08:15:00.000Z" });
    // Lead 读到的是模板和命令，不是解析好的数据（数据是外部内容）。
    const described = await listLeadUiActions(db, { type: "widget", id: String(widget.id) }, { turnId: null });
    expect(described.target).toMatchObject({ surface: template, source: { command: "nasdaq.sh", every_seconds: 900, paused: false } });
    expect(JSON.stringify(described.target)).not.toContain("18,532");
  });

  it("refuses a source whose command fails, prints non-JSON, misses a field, or a template without bindings, and keeps no row", async () => {
    const attempt = (input: object) => runUiAction(db, { target: board, action: "create", input, caller: user, now: clock, services: services() });
    outputs = [{ exitCode: 7, output: "curl: (6) Could not resolve host", timedOut: false }];
    await expect(attempt({ title: "x", surface: template, source })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("退出码 7") });
    outputs = [{ exitCode: 0, output: "hello", timedOut: false }];
    await expect(attempt({ title: "x", surface: template, source })).rejects.toMatchObject({ message: expect.stringContaining("不是 JSON") });
    outputs = [json({ price: "1" })];
    await expect(attempt({ title: "x", surface: template, source })).rejects.toMatchObject({ message: expect.stringContaining("数据里没有 change、tone") });
    const plain = { root: "t", nodes: [{ id: "t", type: "Text", props: { text: "固定的字" } }], fallback_text: "固定的字" };
    await expect(attempt({ title: "x", surface: plain, source })).rejects.toMatchObject({ message: expect.stringContaining("模板里没有绑定") });
    await expect(runUiAction(db, { target: board, action: "create", input: { title: "x", surface: template, source }, caller: user, now: clock }))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM widgets").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM widget_sources").get()).toEqual({ n: 0 });
  });

  it("updates on schedule without Lead: new data changes the card and pushes, unchanged data does not push", async () => {
    const widget = await createNasdaq();
    const runner = createWidgetSourceRunner(db, { runCommand: fakeRun, now: () => clock });
    const pushedAtCreate = reloads();
    await runner.tick();
    expect(commands).toHaveLength(1); // 还没到点
    clock = new Date("2026-10-30T08:15:00.000Z");
    outputs = [json({ price: "18,600", change: "+1.6%", tone: "success" })];
    await runner.tick();
    expect(getWidget(db, widget.id)!.surface.nodes[0]!.props).toMatchObject({ value: "18,600", caption: "+1.6%" });
    expect(reloads()).toBe(pushedAtCreate + 1);
    clock = new Date("2026-10-30T08:30:00.000Z");
    outputs = [json({ price: "18,600", change: "+1.6%", tone: "success" })];
    await runner.tick();
    expect(reloads()).toBe(pushedAtCreate + 1);
    expect(getWidgetSource(db, widget.id)).toMatchObject({ lastOkAt: "2026-10-30T08:30:00.000Z", nextRunAt: "2026-10-30T08:45:00.000Z" });
    expect(listInbox(db).length).toBe(0); // 没有叫醒 Lead
  });

  it("keeps the last good card on errors, pauses after five in a row, wakes Lead once, and resumes on refresh", async () => {
    const widget = await createNasdaq();
    const good = getWidget(db, widget.id)!.surface;
    const runner = createWidgetSourceRunner(db, { runCommand: fakeRun, now: () => clock });
    for (let attempt = 1; attempt <= WIDGET_SOURCE_LIMITS.maxConsecutiveErrors; attempt += 1) {
      clock = new Date(clock.getTime() + 900_000);
      outputs = [attempt % 2 ? new Error("sandbox down") : { exitCode: null, output: "", timedOut: true }];
      await runner.tick();
    }
    const paused = getWidget(db, widget.id)!;
    expect(paused.surface).toEqual(good);
    expect(paused.source).toMatchObject({ paused: true, lastError: expect.stringContaining("命令跑不起来：sandbox down") });
    const wakes = listInbox(db).filter((row: any) => JSON.parse(row.payload ?? "{}").kind === "widget_source_paused");
    expect(wakes).toHaveLength(1);
    clock = new Date(clock.getTime() + 3_600_000);
    await runner.tick();
    expect(commands).toHaveLength(1 + WIDGET_SOURCE_LIMITS.maxConsecutiveErrors); // 暂停了不再跑

    await runUiAction(db, { target: { type: "widget", id: String(widget.id) }, action: "refresh", caller: user, now: clock });
    await runner.tick();
    expect(getWidget(db, widget.id)!.source).toMatchObject({ paused: false, lastError: null });
  });

  it("re-runs on a template or source change, removes the source with null, and refuses refresh on a snapshot", async () => {
    const widget = await createNasdaq();
    const target = { type: "widget", id: String(widget.id) } as const;
    const nextTemplate = { ...template, fallback_text: "纳指 {{price}}" };
    await runUiAction(db, { target, action: "update", input: { surface: nextTemplate }, caller: user, now: clock, services: services() });
    expect(commands).toHaveLength(2);
    expect(getWidget(db, widget.id)!.surface.fallbackText).toBe("纳指 18,532");
    await runUiAction(db, { target, action: "update", input: { title: "纳指" }, caller: user, now: clock, services: services() });
    expect(commands).toHaveLength(2); // 只改标题不重跑
    await runUiAction(db, { target, action: "update", input: { source: null }, caller: user, now: clock, services: services() });
    expect(getWidgetSource(db, widget.id)).toBeNull();
    expect(getWidget(db, widget.id)).toMatchObject({ title: "纳指", source: null, surface: { fallbackText: "纳指 18,532" } });
    await expect(runUiAction(db, { target, action: "refresh", caller: user, now: clock })).rejects.toMatchObject({ code: "unavailable" });
    await runUiAction(db, { target, action: "delete", input: { confirm: true }, caller: user, now: clock });
    expect(db.prepare("SELECT COUNT(*) AS n FROM widget_sources").get()).toEqual({ n: 0 });
  });

  it("restarts a run that a daemon restart interrupted", async () => {
    const widget = await createNasdaq();
    db.prepare("UPDATE widget_sources SET running_since = ?, next_run_at = ? WHERE widget_id = ?").run(clock.toISOString(), "2099-01-01T00:00:00.000Z", widget.id);
    const runner = createWidgetSourceRunner(db, { runCommand: fakeRun, now: () => clock });
    runner.recover();
    await runner.tick();
    expect(commands).toHaveLength(2);
  });
});
