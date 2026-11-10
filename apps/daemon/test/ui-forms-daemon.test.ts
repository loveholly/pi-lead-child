// 会话卡片里的表单（工单 #285）走完整的路径：Lead 用真的 render_ui 画一个绑定 save_fast_model 的表单（daemon 交给 Lead 会话的
// 同一份依赖），Lead 自己调 perform_action 仍被拒绝；用户在卡片上点提交（POST /v1/forms/:id/submit，用户的凭证），
// daemon 以用户本人的身份执行设置页的那个函数，key 存进保险库；设置页（GET /v1/models/settings）看得到新的直觉，
// test_fast_model 用存下的 key 测通（假的决策网关，memory-fakes.ts）。提交结果叫醒 Lead（inbox）。
// 最后用 grep 断言：key 的原值不在事件日志、inbox、gateway 事件、daemon 日志、Lead 拿到的工具结果和数据库文件里。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { UiFormResponseSchema } from "@pi-lead-child/protocol";
import { createLoopbackBinding, listInbox, openDb, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools, type LeadDeps } from "@pi-lead-child/lead";
import { startDaemon } from "../src/server.js";
import { memoryHarness, type MemoryHarness } from "./memory-fakes.js";

// 一个看起来像 key 的值。断言全靠 grep 它。
const SECRET = "tsk-form-secret-7f3a9c41d2";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
let factoryArgs: LeadDeps | null = null;
const logs: string[] = [];

beforeEach(() => {
  dir = tempDir("plc-ui-forms-daemon-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  logs.length = 0;
  factoryArgs = null;
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
});

function sessionFactory() {
  return async (args: unknown) => (factoryArgs = args as LeadDeps, {
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe() { return () => {}; },
      async prompt() {}, async steer() {}, async followUp() {}, dispose() {},
    },
  });
}

async function boot(harness: MemoryHarness) {
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: sessionFactory() as never, gatewayPort: 0, log: (line) => logs.push(line),
    manageMemory: harness.hooks,
  });
  const owner = createLoopbackBinding(db, { name: "test-web" });
  const base = `http://127.0.0.1:${daemon.pairedPort}`;
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${owner.accessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const tools = createLeadTools(factoryArgs!);
  const tool = (name: string) => tools.find((candidate: any) => candidate.name === name) as any;
  return { call, tool };
}

const formCard = {
  root: "card",
  fallback_text: "请填公司决策模型的地址、模型名和 key。",
  nodes: [
    { id: "card", type: "Stack", props: { gap: "md" }, children: ["form"] },
    { id: "form", type: "Form", props: {
      target: { type: "model_settings", id: "models" },
      action: "save_fast_model",
      title: "添加一条直觉",
      submitLabel: "保存",
      fields: [
        { param: "name", kind: "text", label: "名字", default: "公司决策", required: true },
        { param: "baseUrl", kind: "text", label: "地址", required: true, validate: { format: "url" } },
        { param: "model", kind: "text", label: "模型", default: "decision-1", required: true },
        { param: "apiKey", kind: "secret", label: "Key", required: true },
      ],
    } },
  ],
};

// 数据目录里所有的文件（数据库、WAL、config.json、日志……）原样读成文字。
function dataDirText(): string {
  const read = (path: string): string => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .map((entry) => (entry.isDirectory() ? read(join(path, entry.name)) : readFileSync(join(path, entry.name)).toString("latin1")))
        .join("\n");
    } catch {
      return "";
    }
  };
  return read(dir);
}

describe("a form on a conversation card, end to end", () => {
  it("lets the user add a decision model with a key from the card; Lead never sees the key", async () => {
    const harness = memoryHarness(dir);
    const { call, tool } = await boot(harness);
    const leadResults: unknown[] = [];

    // 1. Lead 自己做：只属于用户本人的操作，照旧被拒绝（拒绝里提示可以画表单）。
    const refused = await tool("perform_action").execute("p1", {
      target_type: "model_settings", target_id: "models", action: "save_fast_model",
      input: { name: "公司决策", baseUrl: "https://decision.example.com", model: "decision-1" }, reason: "用户要配一条直觉",
    });
    leadResults.push(refused);
    expect(refused.details).toMatchObject({ refusal: { code: "user_direct" } });
    expect(JSON.stringify(refused)).toContain("Form");

    // 2. Lead 画表单：render_ui 建表单记录，编号写进节点；fallback_text 补一句去哪里填。
    const drawn = await tool("render_ui").execute("r1", structuredClone(formCard));
    leadResults.push(drawn);
    const node = drawn.details.surface.nodes.find((entry: any) => entry.type === "Form");
    const formId = node.props.form as string;
    expect(formId).toMatch(/^frm_/);
    expect(drawn.details.surface.fallbackText).toContain("App 的会话里");
    const initial = await call("GET", `/v1/forms/${formId}`);
    expect(Value.Check(UiFormResponseSchema, initial.body)).toBe(true);
    expect(initial.body.form).toMatchObject({ state: "open", result: null });

    // 3. 值不合格：daemon 用同一个函数校验，什么都不执行。
    const bad = await call("POST", `/v1/forms/${formId}/submit`, { values: { name: "公司决策", baseUrl: "decision.example.com", model: "decision-1", apiKey: SECRET } });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.message ?? JSON.stringify(bad.body)).toMatch(/http/);
    expect((await call("GET", "/v1/models/settings")).body.modelSettings.fast.models.map((model: any) => model.id)).toEqual(["jev"]);

    // 4. 用户在卡片上点提交：以用户本人的身份执行 save_fast_model，key 存进保险库。
    const submitted = await call("POST", `/v1/forms/${formId}/submit`, {
      values: { name: "公司决策", baseUrl: "https://decision.example.com", model: "decision-1", apiKey: SECRET },
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body.form).toMatchObject({ state: "done", result: { ok: true } });
    expect(submitted.body.form.result.message).toContain("decision.example.com");

    // 设置页看得到这一条，key 已设置（来源是设置页存的保险库）。
    const settings = await call("GET", "/v1/models/settings");
    const added = settings.body.modelSettings.fast.models.find((model: any) => model.baseUrl === "https://decision.example.com");
    expect(added).toMatchObject({ name: "公司决策", model: "decision-1", apiKeySet: true, apiKeySource: "settings" });

    // 成功以后不能再交。
    expect((await call("POST", `/v1/forms/${formId}/submit`, { values: {} })).status).toBe(409);

    // 5. test_fast_model 测通：用的是存下的 key（假网关收到的 Authorization 头）。
    const tested = await tool("perform_action").execute("t1", {
      target_type: "model_settings", target_id: "models", action: "test_fast_model", input: { id: added.id }, reason: "用户填完了，测一下",
    });
    leadResults.push(tested);
    expect(tested.details).toMatchObject({ result: { ok: true } });
    expect(harness.requests.at(-1)).toMatchObject({ url: "https://decision.example.com/v1/systemone", authorization: `Bearer ${SECRET}` });

    // 6. 提交结果叫醒 Lead：inbox 里一条 wakeLead，敏感字段只有状态。
    const wake = listInbox(db).map((row) => ({ ...row, payload: JSON.parse(row.payload || "{}") }))
      .find((row) => row.payload.kind === "lead_form_submitted");
    expect(wake?.payload).toMatchObject({ formId, ok: true, wakeLead: true, values: { apiKey: { secret: "set" }, model: "decision-1" } });
    expect(wake?.summary).toContain("已设置");

    // 7. grep：key 的原值不在 Lead 拿得到的任何地方，也不在数据目录的任何文件里（保险库存的是密文）。
    const events = db.prepare("SELECT kind, payload FROM events").all() as Array<{ kind: string; payload: string }>;
    expect(events.some((event) => event.kind === "ui_form.submitted")).toBe(true);
    // 账本：用户本人做的（actor=user），原因写明是在会话卡片的表单里提交的。
    const performed = events.find((event) => event.kind === "ui_action.performed" && event.payload.includes("save_fast_model"));
    expect(JSON.parse(performed!.payload)).toMatchObject({ actor: "user", authority: "user", reason: "在会话卡片的表单「添加一条直觉」里提交" });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(db.prepare("SELECT * FROM inbox").all())).not.toContain(SECRET);
    expect(JSON.stringify(db.prepare("SELECT * FROM gateway_events").all())).not.toContain(SECRET);
    expect(JSON.stringify(leadResults)).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(SECRET);
    // Lead 还能读事件日志（query_events）：读出来的也没有。
    const queried = await tool("query_events").execute("q1", { limit: 100 });
    expect(JSON.stringify(queried)).not.toContain(SECRET);
    db.pragma("wal_checkpoint(TRUNCATE)");
    const files = dataDirText();
    // 对照：读到的确实是存了这一条的数据（config.json 里有它的地址），只是没有 key 的原值。
    expect(files).toContain("https://decision.example.com");
    expect(files).not.toContain(SECRET);
  });

  it("records a failed submit with the reason, lets the user fix it, and keeps the old key when the secret is left empty", async () => {
    const harness = memoryHarness(dir);
    const { call, tool } = await boot(harness);
    // 先由用户在设置页加一条（带 key），再请他在卡片里改地址：key 留空就保留（keep）。
    const first = await call("POST", "/v1/actions/model_settings/models/save_fast_model", {
      input: { name: "公司决策", baseUrl: "https://decision.example.com", model: "decision-1", apiKey: SECRET },
    });
    const id = first.body.result.id as string;
    const drawn = await tool("render_ui").execute("r2", {
      root: "form", fallback_text: "改公司决策的模型名。",
      nodes: [{ id: "form", type: "Form", props: {
        target: { type: "model_settings", id: "models" }, action: "save_fast_model", title: "改直觉",
        fields: [
          { param: "id", kind: "text", label: "编号", readOnly: true, default: id },
          { param: "name", kind: "text", label: "名字", default: "公司决策", required: true },
          { param: "baseUrl", kind: "text", label: "地址", default: "https://decision.example.com", required: true, validate: { format: "url" } },
          { param: "model", kind: "text", label: "模型", required: true },
          { param: "apiKey", kind: "secret", label: "Key", keep: true },
        ],
      } }],
    });
    const formId = drawn.details.surface.nodes[0].props.form as string;

    // readOnly 的字段用表单记录里的值：客户端改了也不算。这里给一个不存在的编号，daemon 照旧用记录里的。
    // 模型名不合格（操作自己的 schema 拒绝）：记成一次失败，卡片写原因，可以改了再交。
    const failed = await call("POST", `/v1/forms/${formId}/submit`, {
      values: { id: "someone-else", name: "公司决策", baseUrl: "https://decision.example.com", model: "bad model!", apiKey: "" },
    });
    expect(failed.status).toBe(200);
    expect(failed.body.form).toMatchObject({ state: "failed", result: { ok: false } });
    const retried = await call("POST", `/v1/forms/${formId}/submit`, {
      values: { name: "公司决策", baseUrl: "https://decision.example.com", model: "decision-2", apiKey: "" },
    });
    expect(retried.body.form).toMatchObject({ state: "done", result: { ok: true } });
    const models = (await call("GET", "/v1/models/settings")).body.modelSettings.fast.models;
    expect(models.find((model: any) => model.id === id)).toMatchObject({ model: "decision-2", apiKeySet: true });
    // key 留空：保留原来的值（测试仍用它）。
    await tool("perform_action").execute("t2", {
      target_type: "model_settings", target_id: "models", action: "test_fast_model", input: { id }, reason: "测一下",
    });
    expect(harness.requests.at(-1)).toMatchObject({ authorization: `Bearer ${SECRET}` });
    const wakes = listInbox(db).map((row) => JSON.parse(row.payload || "{}")).filter((payload) => payload.kind === "lead_form_submitted");
    expect(wakes.map((payload) => [payload.ok, payload.values.apiKey])).toEqual([[false, { secret: "kept" }], [true, { secret: "kept" }]]);
  });
});
