// render_ui 的表单（工单 #285）：只属于用户本人的操作（save_fast_model）可以画成表单，但不能做成按钮；
// 定稿时建表单记录，编号由服务端写（Lead 写的不算），fallback_text 补一句去哪里填。Lead 自己调用照旧被拒，拒绝里提示可以画表单。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { getUiForm, type ModelSettingsService } from "@pi-lead-child/engine";
import { openDb, type Db } from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

let db: Db;
let deps: LeadDeps;
const saved: unknown[] = [];

const modelSettings: ModelSettingsService = {
  summary: () => ({
    brain: { chain: ["vibeproxy/claude-sonnet-5"], current: "vibeproxy/claude-sonnet-5", providers: ["vibeproxy"] },
    fast: { chain: ["jev"], models: [{ id: "jev", name: "jev", host: "api.typesafe.ai", keySet: true }], llmFallback: null },
    maxBackups: 3,
  }),
  get: async () => { throw new Error("not used"); },
  setBrainChain: async () => ({ summary: "x" }),
  saveProvider: async () => ({ summary: "x" }),
  removeProvider: async () => ({ summary: "x" }),
  saveFastModel: async (request) => { saved.push(request); return { summary: "添加了直觉", id: "decision-1" }; },
  removeFastModel: async () => ({ summary: "x" }),
  setFastChain: async () => ({ summary: "x" }),
  testFastModel: async () => ({ ok: true, message: "可用", latencyMs: 1 }),
};

beforeEach(() => {
  const dir = tempDir("plc-render-ui-forms-");
  db = openDb(join(dir, "plc.db"));
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, uiActionServices: { modelSettings } } as LeadDeps;
  saved.length = 0;
});

const tool = (name: string) => createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
const fields = [
  { param: "name", kind: "text", label: "名字", default: "公司决策", required: true },
  { param: "baseUrl", kind: "text", label: "地址", required: true, validate: { format: "url" } },
  { param: "model", kind: "text", label: "模型", default: "decision-1", required: true },
  { param: "apiKey", kind: "secret", label: "Key", required: true },
];
const formCard = (extra: Record<string, unknown> = {}) => ({
  root: "form", fallback_text: "请填公司决策模型的地址、模型名和 key。",
  nodes: [{ id: "form", type: "Form", props: { target: { type: "model_settings", id: "models" }, action: "save_fast_model", title: "添加一条直觉", fields, ...extra } }],
});

describe("forms on a card", () => {
  it("draws a form for a user-only operation and creates its record", async () => {
    // Lead 写的 form 编号不算：换成服务端建的。
    const result = await tool("render_ui").execute("c1", formCard({ form: "frm_forged000000" }));
    const props = result.details.surface.nodes[0].props;
    expect(props.form).toMatch(/^frm_/);
    expect(props.form).not.toBe("frm_forged000000");
    const record = getUiForm(db, props.form);
    expect(record?.created).toMatchObject({ action: "save_fast_model", label: "添加或修改直觉", title: "添加一条直觉" });
    expect(record?.created.fields.map((field) => field.param)).toEqual(["name", "baseUrl", "model", "apiKey"]);
    expect(result.details.surface.fallbackText).toContain("要在 App 的会话里填写、提交；也可以在 设置 → 模型 里自己改");
    expect(result.content[0].text).toContain("用户提交后会叫醒你");
    // 画表单不执行任何东西。
    expect(saved).toEqual([]);
  });

  it("still refuses a user-only operation as a button, and Lead's own call", async () => {
    await expect(tool("render_ui").execute("c2", {
      root: "go", fallback_text: "保存直觉", asks_user: false,
      nodes: [{ id: "go", type: "Action", props: { target: { type: "model_settings", id: "models" }, action: "save_fast_model", role: "primary", input: { name: "公司决策" } } }],
    })).rejects.toThrow(/不能做成卡片按钮；要用户填参数时用 Form/);
    const refused = await tool("perform_action").execute("p1", {
      target_type: "model_settings", target_id: "models", action: "save_fast_model",
      input: { name: "公司决策", baseUrl: "https://decision.example.com", model: "decision-1" }, reason: "用户要配一条直觉",
    });
    expect(refused.details.refusal).toMatchObject({ code: "user_direct" });
    expect(refused.details.refusal.message).toContain("render_ui 画一个 Form");
    expect(saved).toEqual([]);
  });

  it("counts a form as a control on a card that asks the user", async () => {
    const result = await tool("render_ui").execute("c3", { ...formCard(), asks_user: true });
    expect(result.details.surface.nodes[0].type).toBe("Form");
  });

  it("rejects a form for an operation the target does not have", async () => {
    await expect(tool("render_ui").execute("c4", {
      root: "form", fallback_text: "填表",
      nodes: [{ id: "form", type: "Form", props: { target: { type: "model_settings", id: "models" }, action: "save_widget", fields } }],
    })).rejects.toThrow(/没有操作 save_widget/);
  });
});
