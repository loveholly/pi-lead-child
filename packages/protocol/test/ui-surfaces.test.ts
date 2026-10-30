// Lead 生成的富交互卡片（generative UI，2026-10-15 用户决定，.scratch/generative-ui/spec.md）。
// Lead 只能用组件目录里登记过的组件，发出的是数据，不是代码；服务端和客户端用同一个函数校验。
// 不合格的 surface 不渲染半截：报出出错的路径，客户端改为显示 fallbackText。
import { describe, expect, it } from "vitest";
import { foldTurnSurfaces, surfaceNeedsNewerCatalog, UI_CATALOG_VERSION, UI_SURFACE_LIMITS, validateUiSurface, type UiSurface } from "../src/index.js";

const decision: UiSurface = {
  id: "s1",
  catalogVersion: UI_CATALOG_VERSION,
  root: "card",
  fallbackText: "#66 核查不通过，需要你在并入 #72、再返工一次、取消里选一个。",
  nodes: [
    { id: "card", type: "Stack", props: { gap: "md" }, children: ["head", "title", "facts", "choice"] },
    { id: "head", type: "TicketRef", props: { ticket: 66 } },
    { id: "title", type: "Text", props: { text: "核查不通过，返工次数已用完", variant: "title" } },
    {
      id: "facts", type: "FactList", props: {
        items: [
          { label: "F1", text: "撤回的完成声明仍被登记成 complete", status: "reproduced" },
          { label: "F2", text: "补登记旧 Run 会让最新成果退回旧 Run", status: "reproduced" },
          { text: "原来失败的重启 E2E 现在通过", status: "passed" },
        ],
      },
    },
    {
      id: "choice", type: "ChoiceGroup", props: {
        ticket: 66,
        prompt: "#66 接下来怎么办？",
        choices: [
          { id: "merge", label: "并入 #72", consequence: "#66 关闭，F1 和 F2 写进 #72 的验收条件" },
          { id: "rework", label: "再返工一次", consequence: "多给 1 次返工额度" },
          { id: "cancel", label: "取消 #66", consequence: "保留现有产物，不再推进" },
        ],
        recommendation: { choiceId: "merge", reason: "F1 和 #72 改的是同一条 outcome-recovery 路径" },
      },
    },
  ],
};

describe("a generated surface", () => {
  it("accepts a decision card built from catalog components", () => {
    expect(validateUiSurface(decision)).toEqual({ ok: true, surface: decision });
  });

  it("rejects a component that is not in the catalog, naming where", () => {
    const result = validateUiSurface({ ...decision, nodes: [...decision.nodes.slice(0, 1), { id: "head", type: "Html", props: { html: "<b>x</b>" } }, ...decision.nodes.slice(2)] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatchObject({ path: "/nodes/1/type" });
  });

  it("rejects props a component does not declare, so no markup or URL slips through", () => {
    const result = validateUiSurface({
      ...decision,
      nodes: decision.nodes.map((node) => node.id === "title" ? { ...node, props: { ...node.props, href: "https://evil.example" } } : node),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.path).toBe("/nodes/2/props");
  });

  it("rejects children that do not exist, cycles, and nodes the root cannot reach", () => {
    const missing = validateUiSurface({ ...decision, nodes: decision.nodes.map((node) => node.id === "card" ? { ...node, children: ["nope"] } : node) });
    expect(missing).toMatchObject({ ok: false, errors: [expect.objectContaining({ message: expect.stringContaining("nope") })] });
    const cycle = validateUiSurface({
      ...decision, root: "a",
      nodes: [{ id: "a", type: "Stack", props: {}, children: ["b"] }, { id: "b", type: "Stack", props: {}, children: ["a"] }],
    });
    expect(cycle.ok).toBe(false);
    const orphan = validateUiSurface({ ...decision, nodes: [...decision.nodes, { id: "lost", type: "Text", props: { text: "x" } }] });
    expect(orphan.ok).toBe(false);
  });

  it("keeps a recommendation pointing at a real choice", () => {
    const result = validateUiSurface({
      ...decision,
      nodes: decision.nodes.map((node) => node.id === "choice"
        ? { ...node, props: { ...node.props, recommendation: { choiceId: "ship", reason: "r" } } }
        : node),
    });
    expect(result).toMatchObject({ ok: false, errors: [expect.objectContaining({ path: "/nodes/4/props/recommendation/choiceId" })] });
  });

  it("enforces the size limits", () => {
    const many = Array.from({ length: UI_SURFACE_LIMITS.nodes + 1 }, (_, index) => ({ id: `t${index}`, type: "Text" as const, props: { text: "x" } }));
    const result = validateUiSurface({
      ...decision, root: "r",
      nodes: [{ id: "r", type: "Stack", props: {}, children: many.map((node) => node.id) }, ...many],
    });
    expect(result.ok).toBe(false);
    const deep = Array.from({ length: UI_SURFACE_LIMITS.depth + 2 }, (_, index) => ({
      id: `d${index}`, type: "Stack" as const, props: {}, children: index < UI_SURFACE_LIMITS.depth + 1 ? [`d${index + 1}`] : [],
    }));
    expect(validateUiSurface({ ...decision, root: "d0", nodes: deep }).ok).toBe(false);
  });

  it("requires a fallback text, so older clients and plain channels still say something", () => {
    expect(validateUiSurface({ ...decision, fallbackText: "" }).ok).toBe(false);
  });
});

// 组件目录 v2（2026-10-19 用户决定）：复杂的信息也用组件画，不只用在要用户做决定的地方。
// 新组件只追加到目录里，目录版本不变：旧客户端遇到不认识的组件，整张卡显示 fallbackText。
describe("a surface that shows information", () => {
  const overview: UiSurface = {
    id: "overview",
    catalogVersion: UI_CATALOG_VERSION,
    root: "card",
    fallbackText: "本周 12 张工单完成，3 张进行中；#66 等你决定。",
    nodes: [
      { id: "card", type: "Stack", props: {}, children: ["stats", "table", "steps", "progress", "timeline", "bars", "trend"] },
      {
        id: "stats", type: "Stats", props: {
          items: [
            { label: "完成", value: 12, unit: "张", change: "比上周多 4 张", tone: "success" },
            { label: "平均耗时", value: "3.2", unit: "小时" },
          ],
        },
      },
      {
        id: "table", type: "DataTable", props: {
          columns: [{ label: "工单" }, { label: "执行者" }, { label: "CI", align: "center" }, { label: "改动行数" }],
          rows: [
            [{ ticket: 66 }, "Claude Code", { badge: "通过", tone: "success" }, 412],
            [{ ticket: 72 }, "Codex", { badge: "失败", tone: "danger" }, 38],
          ],
        },
      },
      {
        id: "steps", type: "Steps", props: {
          items: [
            { label: "复现", state: "done" },
            { label: "修复", state: "current", detail: "改 outcome-recovery 的登记顺序" },
            { label: "核查", state: "pending" },
          ],
        },
      },
      { id: "progress", type: "Progress", props: { label: "迁移文件", value: 0.4, caption: "120 / 300 个" } },
      {
        id: "timeline", type: "Timeline", props: {
          items: [
            { at: "10-19 09:58", text: "CI 第一次失败" },
            { at: "10-19 10:20", text: "修复后通过", tone: "success" },
          ],
        },
      },
      {
        id: "bars", type: "BarChart", props: {
          unit: "次",
          bars: [{ label: "codex", value: 31 }, { label: "claude", value: 18, tone: "info" }],
        },
      },
      {
        id: "trend", type: "BarChart", props: {
          orientation: "vertical", unit: "万 token", max: 100,
          bars: [{ label: "周一", value: 40 }, { label: "周二", value: 62 }, { label: "周三", value: 0 }],
        },
      },
    ],
  };

  it("accepts tables, stats, steps, progress, timelines and bar charts in the same catalog version", () => {
    expect(UI_CATALOG_VERSION).toBe(1);
    expect(validateUiSurface(overview)).toEqual({ ok: true, surface: overview });
  });

  it("is still rejected as a whole by a client that does not know a component", () => {
    // 旧客户端的目录里没有 DataTable：它按「不认识的组件」处理，整张卡退回 fallbackText。
    const result = validateUiSurface({ ...overview, nodes: overview.nodes.map((node) => node.id === "table" ? { ...node, type: "Chart3D" } : node) });
    expect(result).toMatchObject({ ok: false, errors: [expect.objectContaining({ path: "/nodes/2/type" })] });
  });

  const withProps = (id: string, props: Record<string, unknown>) => ({
    ...overview,
    nodes: overview.nodes.map((node) => node.id === id ? { ...node, props } : node),
  });

  it("lets a table cell refer to a ticket but not copy its fields", () => {
    const copied = withProps("table", {
      columns: [{ label: "工单" }],
      rows: [[{ ticket: 66, status: "进行中" }]],
    });
    expect(validateUiSurface(copied)).toMatchObject({ ok: false, errors: [expect.objectContaining({ path: "/nodes/2/props" })] });
  });

  it("requires every table row to have one cell per column", () => {
    const short = withProps("table", { columns: [{ label: "工单" }, { label: "执行者" }], rows: [[{ ticket: 66 }, "Codex"], ["#72"]] });
    expect(validateUiSurface(short)).toMatchObject({
      ok: false, errors: [expect.objectContaining({ path: "/nodes/2/props/rows/1", message: expect.stringContaining("2 格") })],
    });
  });

  it("caps tables, stats, steps, timelines and bars", async () => {
    const { UI_COMPONENT_LIMITS } = await import("../src/index.js");
    const rows = Array.from({ length: UI_COMPONENT_LIMITS.tableRows + 1 }, (_, index) => [index]);
    expect(validateUiSurface(withProps("table", { columns: [{ label: "n" }], rows })).ok).toBe(false);
    const columns = Array.from({ length: UI_COMPONENT_LIMITS.tableColumns + 1 }, (_, index) => ({ label: `c${index}` }));
    expect(validateUiSurface(withProps("table", { columns, rows: [columns.map(() => 1)] })).ok).toBe(false);
    const stats = Array.from({ length: UI_COMPONENT_LIMITS.stats + 1 }, () => ({ label: "x", value: 1 }));
    expect(validateUiSurface(withProps("stats", { items: stats })).ok).toBe(false);
    const steps = Array.from({ length: UI_COMPONENT_LIMITS.steps + 1 }, () => ({ label: "x", state: "pending" }));
    expect(validateUiSurface(withProps("steps", { items: steps })).ok).toBe(false);
    const events = Array.from({ length: UI_COMPONENT_LIMITS.timeline + 1 }, () => ({ at: "09:58", text: "x" }));
    expect(validateUiSurface(withProps("timeline", { items: events })).ok).toBe(false);
    const bars = Array.from({ length: UI_COMPONENT_LIMITS.bars + 1 }, (_, index) => ({ label: `b${index}`, value: index }));
    expect(validateUiSurface(withProps("bars", { bars })).ok).toBe(false);
  });

  it("rejects a progress outside 0–1, a negative bar, and a bar above the chart's max", () => {
    expect(validateUiSurface(withProps("progress", { label: "迁移", value: 40 })).ok).toBe(false);
    expect(validateUiSurface(withProps("bars", { bars: [{ label: "a", value: -1 }] })).ok).toBe(false);
    expect(validateUiSurface(withProps("trend", { max: 50, bars: [{ label: "周一", value: 40 }, { label: "周二", value: 62 }] }))).toMatchObject({
      ok: false, errors: [expect.objectContaining({ path: "/nodes/7/props/bars/1/value" })],
    });
  });

  it("allows a progress whose amount is unknown", () => {
    expect(validateUiSurface(withProps("progress", { label: "等待 CI" })).ok).toBe(true);
  });

  it("rejects a step state it does not know", () => {
    expect(validateUiSurface(withProps("steps", { items: [{ label: "x", state: "blocked" }] })).ok).toBe(false);
  });

  // partial-json 把正在写的一项解析成 {} 或缺字段的对象。整个节点因此不合格时，表格会在流式中途消失再出现。
  // 去掉正在写的最后一项再校验：表格一行一行地出来，列表一项一项地出来。
  it("streams a table row by row: the row that is still being written waits until it is whole", async () => {
    const { partialUiSurface } = await import("../src/index.js");
    const streaming = (rows: unknown[]) => partialUiSurface({
      root: "card",
      nodes: [
        { id: "card", type: "Stack", props: {}, children: ["table"] },
        { id: "table", type: "DataTable", props: { columns: [{ label: "工单" }, { label: "执行者" }], rows } },
      ],
    }, "c1");
    const table = (rows: unknown[]) => streaming(rows)?.nodes.find((node) => node.id === "table")?.props.rows;
    expect(table([[{ ticket: 66 }, "Codex"], [{ ticket: 72 }]])).toEqual([[{ ticket: 66 }, "Codex"]]);
    expect(table([[{ ticket: 66 }, "Codex"], [{}]])).toEqual([[{ ticket: 66 }, "Codex"]]);
    expect(table([[{ ticket: 66 }, "Codex"], [{ ticket: 72 }, "Cla"]])).toEqual([[{ ticket: 66 }, "Codex"], [{ ticket: 72 }, "Cla"]]);
    expect(table([[{}]])).toBeUndefined();
  });

  it("streams a list item by item", async () => {
    const { partialUiSurface } = await import("../src/index.js");
    const partial = partialUiSurface({
      root: "facts",
      nodes: [{ id: "facts", type: "FactList", props: { items: [{ label: "F1", text: "撤回的完成声明仍被登记" }, { label: "F2" }] } }],
    }, "c1");
    expect(partial?.nodes[0]?.props.items).toEqual([{ label: "F1", text: "撤回的完成声明仍被登记" }]);
  });
});

// 流式（2026-10-15 用户要求「搭配上流式」）：模型还在写 render_ui 的参数时，daemon 用已经完整的节点
// 拼一张「生成中」的卡片先发出去。参数写完、工具执行以后，同一个 callId 的定稿版替换它。
describe("a surface while its arguments still stream", () => {
  it("keeps only the nodes that already validate, and drops children that have not arrived", async () => {
    const { partialUiSurface, uiSurfaceIdForCall } = await import("../src/index.js");
    const partial = partialUiSurface({
      root: "card",
      nodes: [
        { id: "card", type: "Stack", props: {}, children: ["head", "title", "facts"] },
        { id: "head", type: "TicketRef", props: { ticket: 66 } },
        { id: "title", type: "Text", props: { text: "核查不通" } },
        { id: "facts", type: "FactList", props: { items: [{ label: "F1" }] } },
      ],
    }, "call|1");
    expect(partial).toMatchObject({
      id: uiSurfaceIdForCall("call|1"),
      root: "card",
      fallbackText: "正在生成卡片…",
      nodes: [
        { id: "card", children: ["head", "title"] },
        { id: "head" },
        { id: "title", props: { text: "核查不通" } },
      ],
    });
    expect(uiSurfaceIdForCall("call|1")).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("has nothing to show before the root node arrives", async () => {
    const { partialUiSurface } = await import("../src/index.js");
    expect(partialUiSurface({ root: "card", nodes: [{ id: "head", type: "TicketRef", props: { ticket: 66 } }] }, "c1")).toBeNull();
    expect(partialUiSurface({}, "c1")).toBeNull();
  });

  it("folds the streaming and the final versions of one call into one surface", () => {
    const final = { ...decision, id: "decide-66" };
    const folded = foldTurnSurfaces([
      { type: "lead.tool.updated", payload: { toolCallId: "call-1", textOffset: 3, partial: true, surface: { ...decision, id: "s_call-1", fallbackText: "正在生成卡片…" } } },
      { type: "lead.tool.updated", payload: { toolCallId: "call-1", textOffset: 3, surface: final } },
    ]);
    expect(folded).toEqual([{ callId: "call-1", textOffset: 3, surface: final }]);
  });

  // 刷新时这一轮还在流：只有「生成中」的版本。标出来，客户端才知道后面的流式版本可以替换它。
  it("marks a surface that has no final version yet as partial", () => {
    const partial = { ...decision, id: "s_call-1", fallbackText: "正在生成卡片…" };
    expect(foldTurnSurfaces([
      { type: "lead.tool.updated", payload: { toolCallId: "call-1", textOffset: 3, partial: true, surface: partial } },
    ])).toEqual([{ callId: "call-1", textOffset: 3, partial: true, surface: partial }]);
  });

  // 2026-10-24 线上：render_ui 校验失败（FactList 的 status 写成了 warning），流式中途的版本已经落库，
  // 刷新后一直停在「正在生成…」。失败的调用不会再有定稿版本：它的流式版本不显示。
  it("drops the streaming version of a call that failed", () => {
    expect(foldTurnSurfaces([
      { type: "lead.tool.updated", payload: { toolCallId: "call-1", textOffset: 0, partial: true, surface: { ...decision, id: "decide" } } },
      { type: "lead.tool.failed", payload: { toolCallId: "call-1", toolName: "render_ui" } },
    ])).toEqual([]);
  });

  // spec D3：同一个 surface_id 再画一次就是替换。线上 4 次重画都用了原来的 id，用户却看到两张卡。
  it("replaces a surface drawn again with the same id in the same turn", () => {
    const first = { ...decision, id: "decide", fallbackText: "第一版" };
    const second = { ...decision, id: "decide", fallbackText: "第二版" };
    expect(foldTurnSurfaces([
      { type: "lead.tool.updated", payload: { toolCallId: "call-1", textOffset: 0, partial: true, surface: first } },
      { type: "lead.tool.failed", payload: { toolCallId: "call-1", toolName: "render_ui" } },
      { type: "lead.tool.updated", payload: { toolCallId: "call-2", textOffset: 0, partial: true, surface: second } },
      { type: "lead.tool.updated", payload: { toolCallId: "call-2", textOffset: 0, surface: second } },
    ])).toEqual([{ callId: "call-2", textOffset: 0, surface: second }]);
    expect(foldTurnSurfaces([
      { type: "lead.tool.updated", payload: { toolCallId: "call-1", textOffset: 0, surface: first } },
      { type: "lead.tool.updated", payload: { toolCallId: "call-2", textOffset: 5, surface: second } },
    ])).toEqual([{ callId: "call-2", textOffset: 5, surface: second }]);
  });

  // 重画还在流、或者重画失败了：用户继续看已经定稿的那一版，不出现第二张「正在生成…」的卡。
  it("keeps the final version while a redraw with the same id streams or fails", () => {
    const first = { ...decision, id: "decide", fallbackText: "第一版" };
    const redraw = { ...decision, id: "decide", fallbackText: "第二版" };
    const finalFirst = { type: "lead.tool.updated", payload: { toolCallId: "call-1", textOffset: 0, surface: first } };
    const streamingRedraw = { type: "lead.tool.updated", payload: { toolCallId: "call-2", textOffset: 0, partial: true, surface: redraw } };
    expect(foldTurnSurfaces([finalFirst, streamingRedraw])).toEqual([{ callId: "call-1", textOffset: 0, surface: first }]);
    expect(foldTurnSurfaces([
      finalFirst, streamingRedraw, { type: "lead.tool.failed", payload: { toolCallId: "call-2", toolName: "render_ui" } },
    ])).toEqual([{ callId: "call-1", textOffset: 0, surface: first }]);
  });
});

// spec D7：Lead 可能把 child 的输出抄进卡片。卡片落库和发出之前去掉密钥，和工具记录一样。
describe("a surface with a secret in its text", () => {
  it("is redacted before it is stored or sent, while it streams and when it is final", async () => {
    const { partialUiSurface, redactUiSurface } = await import("../src/index.js");
    const leaky: UiSurface = {
      ...decision,
      fallbackText: "失败：EPERM token=sk-live-abcdefghijklmnop",
      nodes: decision.nodes.map((node) => node.id === "facts"
        ? { ...node, props: { items: [{ label: "F1", text: "日志里有 token=sk-live-abcdefghijklmnop", status: "reproduced" }] } }
        : node),
    };
    const clean = redactUiSurface(leaky);
    expect(JSON.stringify(clean)).not.toContain("sk-live-abcdefghijklmnop");
    expect(validateUiSurface(clean).ok).toBe(true);
    const partial = partialUiSurface({ root: "t", nodes: [{ id: "t", type: "Text", props: { text: "token=sk-live-abcdefghijklmnop" } }] }, "c1");
    expect(JSON.stringify(partial)).not.toContain("sk-live-abcdefghijklmnop");
  });
});


// 2026-10-20：部署了组件目录 v2 以后，已经打开的旧页面不认识 DataTable、Stats、BarChart，整张卡只剩 fallbackText，
// 用户以为生成式 UI 坏了。服务端校验过的卡，客户端却不认识里面的组件：说明客户端的版本旧，刷新后能显示。
// 客户端按错误的 code 判断原因，不读 message 的文字。
describe("a surface made with a newer catalog than this one", () => {
  it("names a component this catalog does not have", () => {
    const result = validateUiSurface({ ...decision, nodes: decision.nodes.map((node) => node.id === "head" ? { id: "head", type: "LineChart", props: { points: [1, 2] } } : node) });
    expect(result).toMatchObject({ ok: false, errors: [{ path: "/nodes/1/type", code: "unknown_component" }] });
    expect(surfaceNeedsNewerCatalog(result)).toBe(true);
  });

  it("names a catalog version newer than this one", () => {
    const result = validateUiSurface({ ...decision, catalogVersion: UI_CATALOG_VERSION + 1 });
    expect(result).toMatchObject({ ok: false, errors: [{ path: "/catalogVersion", code: "newer_catalog" }] });
    expect(surfaceNeedsNewerCatalog(result)).toBe(true);
  });

  it("does not blame the version for other problems", () => {
    const badProps = validateUiSurface({
      ...decision,
      nodes: decision.nodes.map((node) => node.id === "title" ? { ...node, props: { ...node.props, href: "https://evil.example" } } : node),
    });
    const orphan = validateUiSurface({ ...decision, nodes: [...decision.nodes, { id: "lost", type: "Text", props: { text: "x" } }] });
    const notASurface = validateUiSurface({ id: "s1" });
    for (const result of [badProps, orphan, notASurface]) {
      expect(result.ok).toBe(false);
      expect(surfaceNeedsNewerCatalog(result)).toBe(false);
    }
    expect(surfaceNeedsNewerCatalog(validateUiSurface(decision))).toBe(false);
  });
});

// genui v3 积木（2026-10-27，.scratch/genui-catalog-v3/spec.md 积木 1、2、7、10）。尺寸只由 props 和主题决定：
// 太长的值校验失败、不截断；Media 正好两个子节点；别人的话只能引用，流式中途不带服务端填的原文。
describe("v3 blocks", () => {
  const card = (nodes: UiSurface["nodes"], root = nodes[0]!.id): UiSurface => ({
    id: "v3", catalogVersion: UI_CATALOG_VERSION, root, fallbackText: "一张卡。", nodes,
  });
  const tile = (id: string, value: number | string = 29) => ({ id, type: "Tile", props: { eyebrow: "10月", value, caption: "周四 14:00" } });
  const body = { id: "body", type: "Text", props: { text: "彪哥 last day", variant: "title" } };

  it("accepts a ticket stub: a tile in front of a body", () => {
    const checked = validateUiSurface(card([{ id: "row", type: "Media", props: { attach: true }, children: ["date", "body"] }, tile("date"), body]));
    expect(checked.ok).toBe(true);
  });

  it("refuses a tile value longer than eight characters instead of cutting it, and names the field", () => {
    const checked = validateUiSurface(card([tile("t", "10-29 14:00")]));
    // 2026-10-27 评测：Lead 只收到「props 不符合目录」，不知道是 value 太长。
    expect(checked).toMatchObject({ ok: false, errors: [{ path: "/nodes/0/props", message: expect.stringContaining("/value") }] });
  });

  // 2026-10-27 评测：sm 图块的小标题「周二 10-27」显示成「周二 10-…」。图块宽度固定，放不下就校验失败，不截断。
  it("refuses an eyebrow or caption that does not fit on one line of the tile", () => {
    const small = validateUiSurface(card([{ id: "t", type: "Tile", props: { eyebrow: "周二 10-27", value: "10:00", size: "sm" } }]));
    expect(small).toMatchObject({ ok: false, errors: [{ path: "/nodes/0/props/eyebrow", message: expect.stringContaining("放不下一行") }] });
    expect(validateUiSurface(card([{ id: "t", type: "Tile", props: { eyebrow: "周二 10-27", value: "10:00" } }])).ok).toBe(true);
    expect(validateUiSurface(card([{ id: "t", type: "Tile", props: { eyebrow: "周二", value: "10:00", caption: "10-27 3F-2 会议室", size: "sm" } }])).ok).toBe(false);
    // 放得下的说明照常通过（2026-10-27 第二轮评测里它被拒过一次）。
    expect(validateUiSurface(card([{ id: "t", type: "Tile", props: { eyebrow: "第 3 节", value: "87:84", caption: "主队领先 3 分" } }])).ok).toBe(true);
  });

  it("wants exactly two children in a Media, the first a Tile or a Badge", () => {
    const one = validateUiSurface(card([{ id: "row", type: "Media", props: {}, children: ["date"] }, tile("date")]));
    expect(one).toMatchObject({ ok: false, errors: [{ path: "/nodes/0/children" }] });
    const text = validateUiSurface(card([{ id: "row", type: "Media", props: {}, children: ["body", "date"] }, body, tile("date")]));
    expect(text).toMatchObject({ ok: false, errors: [{ path: "/nodes/0/children/0" }] });
  });

  it("allows at most four tiles and one quoted conversation in a card", () => {
    const tiles = ["a", "b", "c", "d", "e"].map((id) => tile(id));
    const five = validateUiSurface(card([{ id: "s", type: "Stack", props: { direction: "row" }, children: tiles.map((t) => t.id) }, ...tiles]));
    expect(five).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining("最多 4 个 Tile") }] });
    const message = (id: string) => ({ id, type: "Message", props: { ref: { type: "channel_card", id: 3 }, mode: "latest" } });
    const two = validateUiSurface(card([{ id: "s", type: "Stack", props: {}, children: ["m1", "m2"] }, message("m1"), message("m2")]));
    expect(two).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining("最多 1 个 Message") }] });
  });

  it("accepts a row of results with a summary, up to eight", () => {
    const items = Array.from({ length: 8 }, (_, index) => ({ label: `检查${index + 1}`, tone: "success" }));
    expect(validateUiSurface(card([{ id: "seg", type: "Segments", props: { items, summary: "8/8 通过" } }])).ok).toBe(true);
    expect(validateUiSurface(card([{ id: "seg", type: "Segments", props: { items: [...items, { label: "九" }] } }])).ok).toBe(false);
  });

  it("drops the quoted words Lead typed while the card is still streaming", async () => {
    const { partialUiSurface } = await import("../src/index.js");
    const partial = partialUiSurface({
      root: "m", fallback_text: "王小明连发了 5 条。",
      nodes: [{ id: "m", type: "Message", props: { ref: { type: "channel_card", id: 3 }, mode: "latest", sender: "假的", messages: [{ at: "x", text: "Lead 打的" }] } }],
    }, "call-1");
    expect(partial?.nodes[0]!.props).toEqual({ ref: { type: "channel_card", id: 3 }, mode: "latest" });
  });
});

// genui v3 积木 3–6（2026-10-27）：状态绑定、收起和展开、卡片上的按钮、参数输入。用户要求提醒卡那种「点开改时间、实时剩余时间」
// 也能用积木拼出来。规则：展开态只在浮层里（Field 只能放在 detail 里）；按钮只能做注册表里的操作、只写登记过的参数。
describe("v3 interactive blocks", () => {
  const card = (nodes: UiSurface["nodes"]): UiSurface => ({ id: "v3i", catalogVersion: UI_CATALOG_VERSION, root: nodes[0]!.id, fallbackText: "提醒卡。", nodes });
  const reminder = (extra: Partial<Record<string, unknown>> = {}) => card([
    { id: "box", type: "Disclosure", props: { label: "提醒的操作", lines: 2, detail: ["opts"], ...extra }, children: ["row", "opts"] },
    { id: "row", type: "Media", props: { attach: true }, children: ["date", "body"] },
    { id: "date", type: "Tile", props: { eyebrow: "10月", value: 29, size: "sm", bind: { ticket: 83, field: "stage" } } },
    { id: "body", type: "Stack", props: { gap: "sm" }, children: ["title", "when"] },
    { id: "title", type: "Text", props: { text: "彪哥今天 last day", variant: "title" } },
    { id: "when", type: "Text", props: { text: "周四 14:00", variant: "caption", bind: { ticket: 83, field: "remindAt", format: "remaining" } } },
    { id: "opts", type: "Stack", props: { gap: "md" }, children: ["pick", "save", "cancel"] },
    { id: "pick", type: "Field", props: { for: "save", param: "remindAt", kind: "datetime", presets: [{ label: "1 小时后", value: "+1h" }, { label: "明天 09:00", value: "+1d 09:00" }, { label: "下周一 09:00", value: "mon 09:00" }], freeInput: true } },
    { id: "save", type: "Action", props: { target: { type: "reminder", id: "83" }, action: "reschedule", role: "primary", label: "改时间" } },
    { id: "cancel", type: "Action", props: { target: { type: "ticket", id: 83 }, action: "cancel", role: "default" } },
  ]);

  it("accepts the reminder card from the canvas built only from blocks", () => {
    const checked = validateUiSurface(reminder());
    expect(checked.ok ? null : checked.errors).toBeNull();
  });

  it("keeps a field out of the conversation list: only inside the expanded part", () => {
    const surface = reminder({ detail: ["opts"] });
    const flat = { ...surface, nodes: surface.nodes.map((node) => (node.id === "box" ? { ...node, children: ["row", "pick", "opts"] } : node.id === "opts" ? { ...node, children: ["save", "cancel"] } : node)) };
    expect(validateUiSurface(flat)).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining("Field 只能放在 Disclosure 的 detail") }] });
  });

  it("needs at least one child left in the collapsed part, and no Disclosure inside another", () => {
    expect(validateUiSurface(reminder({ detail: ["row", "opts"] }))).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining("至少留一个子节点在收起态") }] });
    expect(validateUiSurface(reminder({ detail: ["nope"] }))).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining("不是这个 Disclosure 的子节点") }] });
  });

  it("refuses a button for an operation the registry does not have, or a parameter it does not take", () => {
    const surface = reminder();
    const swap = (id: string, props: Record<string, unknown>) => ({ ...surface, nodes: surface.nodes.map((node) => (node.id === id ? { ...node, props: { ...node.props, ...props } } : node)) });
    expect(validateUiSurface(swap("save", { action: "postpone" }))).toMatchObject({ ok: false, errors: [{ path: "/nodes/8/props/action" }] });
    expect(validateUiSurface(swap("save", { input: { when: "x" } }))).toMatchObject({ ok: false, errors: [{ path: "/nodes/8/props/input/when" }] });
    expect(validateUiSurface(swap("pick", { param: "when" }))).toMatchObject({ ok: false, errors: [{ path: "/nodes/7/props/param" }] });
    expect(validateUiSurface(swap("pick", { presets: [{ label: "明天", value: "tomorrow" }] }))).toMatchObject({ ok: false, errors: [{ path: "/nodes/7/props/presets/0/value" }] });
    expect(validateUiSurface(swap("cancel", { role: "primary" }))).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining("最多 1 个 role 是 primary") }] });
  });

  it("works out a time option when it is pressed, not when the card is drawn", async () => {
    const { resolveDatetimePreset } = await import("../src/index.js");
    // 2026-10-27 是周二。
    const now = new Date(2026, 9, 27, 10, 30);
    expect(resolveDatetimePreset("+1h", now)).toBe(new Date(2026, 9, 27, 11, 30).toISOString());
    expect(resolveDatetimePreset("+1d 09:00", now)).toBe(new Date(2026, 9, 28, 9, 0).toISOString());
    expect(resolveDatetimePreset("mon 09:00", now)).toBe(new Date(2026, 10, 2, 9, 0).toISOString());
    expect(resolveDatetimePreset("tue 09:00", now)).toBe(new Date(2026, 10, 3, 9, 0).toISOString());
    expect(resolveDatetimePreset("2026-10-30T14:00:00+08:00", now)).toBe("2026-10-30T06:00:00.000Z");
    expect(resolveDatetimePreset("+3h30m", now)).toBe(new Date(2026, 9, 27, 14, 0).toISOString());
    expect(resolveDatetimePreset("tomorrow", now)).toBeNull();
  });

  it("streams the collapsed part before the expanded part arrives", async () => {
    const { partialUiSurface } = await import("../src/index.js");
    const full = reminder();
    const partial = partialUiSurface({ root: "box", fallback_text: "提醒卡。", nodes: full.nodes.filter((node) => !["opts", "pick", "save", "cancel"].includes(node.id)) }, "c1");
    expect(partial?.nodes.find((node) => node.id === "box")).toMatchObject({ children: ["row"], props: { detail: [] } });
  });
});

// 模式组件「事项」（2026-10-27，三层的中间层）：航班、比分、发布、一组待办都是它。
describe("the Item pattern", () => {
  const card = (nodes: UiSurface["nodes"]): UiSurface => ({ id: "item", catalogVersion: UI_CATALOG_VERSION, root: nodes[0]!.id, fallbackText: "一件事。", nodes });
  it("accepts a flight with a button on the right, and a to-do group with a table to open", () => {
    expect(validateUiSurface(card([
      { id: "f", type: "Item", props: { lead: { eyebrow: "登机口", value: "B12", caption: "15:40 关闭", tone: "warning", emphasis: "strong" }, title: "CA1501 北京 → 上海", meta: "16:10 起飞 · 18:25 到达" }, children: ["pass"] },
      { id: "pass", type: "Action", props: { target: { type: "ticket", id: 3 }, action: "cancel", role: "quiet", label: "登机牌" } },
    ])).ok).toBe(true);
    expect(validateUiSurface(card([
      { id: "todo", type: "Item", props: { lead: { eyebrow: "待审", value: 12, tone: "warning", size: "sm" }, title: "12 个 PR 等你 review", meta: "最早的一个等了 3 天" }, children: ["t"] },
      { id: "t", type: "DataTable", props: { columns: [{ label: "PR" }], rows: [[{ ticket: 1 }]] } },
    ])).ok).toBe(true);
  });

  it("needs a title or a sentence, and checks the tile like a Tile", () => {
    expect(validateUiSurface(card([{ id: "x", type: "Item", props: { lead: { value: 1 } } }]))).toMatchObject({ ok: false, errors: [{ message: "Item 要有 title 或 text" }] });
    expect(validateUiSurface(card([{ id: "x", type: "Item", props: { lead: { eyebrow: "周二 10-27", value: "10:00", size: "sm" }, title: "面试" } }])))
      .toMatchObject({ ok: false, errors: [{ path: "/nodes/0/props/lead/eyebrow" }] });
  });

  it("allows one button on the right, and one thing per card that opens", () => {
    const button = (id: string) => ({ id, type: "Action", props: { target: { type: "ticket", id: 3 }, action: "cancel", role: "quiet" } });
    expect(validateUiSurface(card([{ id: "x", type: "Item", props: { lead: { value: 1 }, title: "a" }, children: ["b1", "b2"] }, button("b1"), button("b2")])))
      .toMatchObject({ ok: false, errors: [{ message: expect.stringContaining("Item 最多一个 Action") }] });
    const item = (id: string, detail: string) => ({ id, type: "Item", props: { lead: { value: 1 }, title: id }, children: [detail] });
    const text = (id: string) => ({ id, type: "Text", props: { text: id } });
    expect(validateUiSurface(card([{ id: "s", type: "Stack", props: {}, children: ["a", "b"] }, item("a", "ta"), item("b", "tb"), text("ta"), text("tb")])))
      .toMatchObject({ ok: false, errors: [{ message: expect.stringContaining("最多一个能点开") }] });
  });
});

// 同类合并（2026-10-28 用户定：一张卡最多 3 个 Group，每个点开是各自的浮层）。
describe("the Group pattern", () => {
  const card = (nodes: UiSurface["nodes"]): UiSurface => ({ id: "group", catalogVersion: UI_CATALOG_VERSION, root: nodes[0]!.id, fallbackText: "几件同类的事。", nodes });
  const text = (id: string) => ({ id, type: "Text", props: { text: `第 ${id} 条评论` } });
  const group = (id: string, children: string[], extra: Record<string, unknown> = {}) => ({ id, type: "Group", props: { label: "行内评论", tag: "已加", ...extra }, children });
  const lines = Array.from({ length: 12 }, (_, index) => text(`c${index + 1}`));

  it("accepts a failure written on its own and three groups, and does not count grouped items as tiles", () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      id: `i${index}`, type: "Item", props: { lead: { value: index + 1, size: "sm" }, title: `ledger.py:${index + 80}` },
    }));
    expect(validateUiSurface(card([
      { id: "s", type: "Stack", props: {}, children: ["fail", "g1", "g2", "g3"] },
      { id: "fail", type: "Text", props: { text: "第 4/13 条没加上：行号不在这次改动里" } },
      group("g1", lines.slice(0, 6).map((line) => line.id)),
      group("g2", items.map((item) => item.id), { tag: "跳过", label: "和已有评论重复" }),
      group("g3", lines.slice(6).map((line) => line.id), { tone: "warning", tag: "待定" }),
      ...lines, ...items,
    ])).ok).toBe(true);
  });

  it("allows at most three groups in a card", () => {
    const four = ["g1", "g2", "g3", "g4"].map((id, index) => group(id, [`c${index + 1}`]));
    expect(validateUiSurface(card([{ id: "s", type: "Stack", props: {}, children: four.map((g) => g.id) }, ...four, ...lines.slice(0, 4)])))
      .toMatchObject({ ok: false, errors: [{ message: expect.stringContaining("最多 3 个 Group") }] });
  });

  it("keeps a group flat: only items and text, no item that opens, no group inside a group or a Disclosure", () => {
    expect(validateUiSurface(card([group("g", ["t"]), { id: "t", type: "DataTable", props: { columns: [{ label: "PR" }], rows: [[{ ticket: 1 }]] } }])))
      .toMatchObject({ ok: false, errors: [{ message: expect.stringContaining("只放 Item 或 Text") }] });
    expect(validateUiSurface(card([
      group("g", ["i"]),
      { id: "i", type: "Item", props: { lead: { value: 1 }, title: "带细节" }, children: ["d"] },
      text("d"),
    ]))).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining("不带细节") }] });
    expect(validateUiSurface(card([
      { id: "box", type: "Disclosure", props: { label: "更多", detail: ["g"] }, children: ["head", "g"] },
      text("head"), group("g", ["c1"]), lines[0]!,
    ]))).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining("不能放进 Disclosure") }] });
    expect(validateUiSurface(card([group("g", [])]))).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining("至少要有一件") }] });
  });
});
