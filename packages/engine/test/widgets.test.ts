// 自定义控件（用户 2026-10-30，.scratch/custom-views/spec.md D1、D7）：视图面板上建控件、排序、视图改名，一个控件上改、删。
// 页面和 Lead 走同一个操作（widget_board、widget）。模板和 render_ui 同一个写法、同一个校验，另外不能用一次性的组件。
// 视图是控件的一个属性，缺省 default；只有一个视图时面板不显示 tab。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { DEFAULT_VIEW, WIDGET_LIMITS, widgetViews, type WidgetDto } from "@pi-lead-child/protocol";
import { listWidgets, openDb, type Db } from "@pi-lead-child/store";
import { listLeadUiActions, runUiAction, uiActionCatalogText } from "../src/index.js";

let db: Db;
const NOW = new Date("2026-10-30T08:00:00.000Z");
const user = { kind: "user" } as const;
const lead = { kind: "lead", turnId: null } as const;
const external = [{ via: "message", source: "slack" }] as const;
const board = { type: "widget_board", id: "widgets" } as const;

beforeEach(() => {
  db = openDb(join(tempDir("plc-widgets-"), "plc.db"));
});

const nasdaq = (value = "18,532") => ({
  root: "tile",
  nodes: [{ id: "tile", type: "Tile", props: { eyebrow: "纳斯达克", value, caption: "10-30 16:00" } }],
  fallback_text: `纳斯达克 ${value}（10-30 16:00）`,
});
const reloads = () => db.prepare("SELECT payload FROM gateway_events WHERE event_type = 'snapshot.required'").all()
  .map((row: any) => JSON.parse(row.payload)).filter((payload) => payload.resource === "widgets");
const create = async (title: string, caller: typeof user | typeof lead = user, view?: string) =>
  (await runUiAction(db, {
    target: board, action: "create", input: { title, surface: nasdaq(), ...(view ? { view } : {}) }, reason: "用户要", caller, now: NOW,
  })).result as WidgetDto;
const titlesIn = (view: string) => listWidgets(db).filter((widget) => widget.view === view).map((widget) => widget.title);

describe("custom widgets", () => {
  it("lets Lead create a widget from a render_ui-shaped template, in the default view, on top, and tells the clients to reload", async () => {
    const first = await create("指数", lead);
    const second = await create("天气");
    expect(listWidgets(db).map((widget) => [widget.id, widget.title, widget.view, widget.createdBy])).toEqual([
      [second.id, "天气", DEFAULT_VIEW, "user"], [first.id, "指数", DEFAULT_VIEW, "lead"],
    ]);
    expect(first.surface).toMatchObject({
      id: `widget_${first.id}`, root: "tile", fallbackText: "纳斯达克 18,532（10-30 16:00）",
      nodes: [{ id: "tile", type: "Tile", props: { value: "18,532" } }],
    });
    expect(widgetViews(listWidgets(db))).toEqual([DEFAULT_VIEW]);
    expect(reloads()).toHaveLength(2);
  });

  it("rejects a template that fails the render_ui checks or uses a one-shot component, and keeps no row", async () => {
    const bad = { root: "x", nodes: [{ id: "x", type: "Nope", props: {} }], fallback_text: "x" };
    await expect(runUiAction(db, { target: board, action: "create", input: { title: "坏的", surface: bad }, caller: user, now: NOW }))
      .rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("组件目录里没有 Nope") });
    const choice = {
      root: "c",
      nodes: [{ id: "c", type: "ChoiceGroup", props: { ticket: 1, question: "选哪个", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } }],
      fallback_text: "选哪个",
    };
    await expect(runUiAction(db, { target: board, action: "create", input: { title: "选择", surface: choice }, caller: user, now: NOW }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(listWidgets(db)).toEqual([]);
    expect(reloads()).toEqual([]);
  });

  it("refuses buttons for operations only the user can do, like render_ui", async () => {
    const button = {
      root: "a",
      nodes: [{ id: "a", type: "Action", props: { target: { type: "device", id: "1" }, action: "revoke", role: "default" } }],
      fallback_text: "撤销设备",
    };
    await expect(runUiAction(db, { target: board, action: "create", input: { title: "设备", surface: button }, caller: user, now: NOW }))
      .rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("不能做成控件里的按钮") });
  });

  it("updates the title, the template or the view, and needs at least one of them", async () => {
    const widget = await create("指数");
    const target = { type: "widget", id: String(widget.id) } as const;
    await expect(runUiAction(db, { target, action: "update", input: {}, caller: user, now: NOW })).rejects.toMatchObject({ code: "invalid_input" });
    await runUiAction(db, { target, action: "update", input: { surface: nasdaq("18,600") }, reason: "用户要更新", caller: lead, now: NOW });
    await runUiAction(db, { target, action: "update", input: { title: "纳指" }, caller: user, now: NOW });
    const [updated] = listWidgets(db);
    expect(updated).toMatchObject({ title: "纳指", view: DEFAULT_VIEW, surface: { id: `widget_${widget.id}`, nodes: [{ props: { value: "18,600" } }] } });
  });

  it("deletes only with confirm, and reorders only with the full list", async () => {
    const a = await create("A");
    const b = await create("B");
    const c = await create("C");
    await expect(runUiAction(db, { target: board, action: "reorder", input: { ids: [a.id, b.id] }, caller: user, now: NOW }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await runUiAction(db, { target: board, action: "reorder", input: { ids: [a.id, b.id, c.id] }, caller: user, now: NOW });
    expect(listWidgets(db).map((widget) => widget.title)).toEqual(["A", "B", "C"]);
    const target = { type: "widget", id: String(b.id) } as const;
    await expect(runUiAction(db, { target, action: "delete", caller: user, now: NOW })).rejects.toMatchObject({ code: "needs_confirmation" });
    await runUiAction(db, { target, action: "delete", input: { confirm: true }, caller: user, now: NOW });
    expect(listWidgets(db).map((widget) => widget.title)).toEqual(["A", "C"]);
    await expect(runUiAction(db, { target, action: "update", input: { title: "x" }, caller: user, now: NOW })).rejects.toMatchObject({ code: "not_found" });
  });

  it("stops at the widget limit and says why", async () => {
    for (let index = 0; index < WIDGET_LIMITS.widgets; index += 1) await create(`控件 ${index + 1}`);
    const listed = await listLeadUiActions(db, board, { turnId: null });
    expect(listed.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "create", available: false, reason: `已经有 ${WIDGET_LIMITS.widgets} 个控件了，先删掉不用的` }),
    ]));
    await expect(create("多的")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("is not a rule change: Lead can still do it in a turn that read external content", async () => {
    const outcome = await runUiAction(db, {
      target: board, action: "create", input: { title: "指数", surface: nasdaq() }, reason: "用户在 Slack 里要的",
      caller: { kind: "lead", turnId: null, externalContent: external }, now: NOW,
    });
    expect(outcome.forLead).toMatchObject({ result: "created" });
    expect(uiActionCatalogText()).toContain("widget_board（自定义视图面板");
  });
});

describe("views as a property of widgets", () => {
  it("puts a widget in a named view only when asked, orders the tabs default-first, and drops a view when it is empty", async () => {
    const weather = await create("天气");
    const nasdaqWidget = await create("纳斯达克", lead, "投资");
    await create("比特币", lead, "投资");
    await create("通勤", lead, "出行");
    expect(widgetViews(listWidgets(db))).toEqual([DEFAULT_VIEW, "投资", "出行"]);
    expect(titlesIn("投资")).toEqual(["比特币", "纳斯达克"]);
    const described = await listLeadUiActions(db, board, { turnId: null });
    expect(described.target).toMatchObject({ views: [{ view: "default", label: "常用" }, { view: "投资", label: "投资" }, { view: "出行", label: "出行" }] });

    // 移到别的视图：用 update 的 view。缺省的视图空了就没了；「出行」里现在有最早建的控件，排到前面。
    await runUiAction(db, { target: { type: "widget", id: String(weather.id) }, action: "update", input: { view: "出行" }, caller: user, now: NOW });
    expect(widgetViews(listWidgets(db))).toEqual(["出行", "投资"]);
    await runUiAction(db, { target: { type: "widget", id: String(nasdaqWidget.id) }, action: "delete", input: { confirm: true }, caller: user, now: NOW });
    expect(titlesIn("投资")).toEqual(["比特币"]);
  });

  it("renames a view for all its widgets, merges into an existing name, and refuses an unknown view or a blank name", async () => {
    await create("纳斯达克", lead, "投资");
    await create("比特币", lead, "加密");
    await create("天气");
    await runUiAction(db, { target: board, action: "rename_view", input: { view: "default", name: "日常" }, reason: "用户要", caller: lead, now: NOW });
    expect(widgetViews(listWidgets(db))).toEqual(["投资", "加密", "日常"]);
    const merged = await runUiAction(db, { target: board, action: "rename_view", input: { view: "加密", name: "投资" }, caller: user, now: NOW });
    expect(merged.result).toEqual({ view: "投资", widgets: 1 });
    expect(titlesIn("投资")).toEqual(["比特币", "纳斯达克"]);
    await expect(runUiAction(db, { target: board, action: "rename_view", input: { view: "没有", name: "x" }, caller: user, now: NOW }))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(runUiAction(db, { target: board, action: "rename_view", input: { view: "投资", name: "  " }, caller: user, now: NOW }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(reloads()).toHaveLength(5);
  });

  it("stops at the view limit, but still allows more widgets in an existing view", async () => {
    for (let index = 0; index < WIDGET_LIMITS.views; index += 1) await create(`控件 ${index}`, lead, `视图${index}`);
    await expect(create("多的", lead, "新视图")).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining(`${WIDGET_LIMITS.views} 个视图`) });
    const extra = await create("再一个", lead, "视图0");
    await expect(runUiAction(db, { target: { type: "widget", id: String(extra.id) }, action: "update", input: { view: "新视图" }, caller: user, now: NOW }))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(titlesIn("视图0")).toEqual(["再一个", "控件 0"]);
  });
});
