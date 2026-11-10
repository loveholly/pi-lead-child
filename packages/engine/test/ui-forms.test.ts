// 表单的记录和提交（工单 #285，engine 的 ui-actions/forms.ts）：提交只认表单记录，校验不过什么都不执行；
// 操作失败记成一次失败、可以再交；成功以后不能再交；结果叫醒 Lead。敏感值不进事件和 inbox，错误原文里的也擦掉。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { listInbox, openDb, type Db } from "@pi-lead-child/store";
import type { UiFormField } from "@pi-lead-child/protocol";
import { UiActionError, createUiForm, getUiForm, submitUiForm, uiFormDto } from "../src/index.js";

const SECRET = "tsk-engine-secret-91ab";
const FIELDS: UiFormField[] = [
  { param: "name", kind: "text", label: "名字", required: true },
  { param: "baseUrl", kind: "text", label: "地址", required: true, validate: { format: "url" } },
  { param: "model", kind: "text", label: "模型", required: true },
  { param: "apiKey", kind: "secret", label: "Key", keep: true },
];

let db: Db;
let formId: string;

beforeEach(() => {
  db = openDb(join(tempDir("plc-ui-forms-"), "plc.db"));
  formId = createUiForm(db, {
    surfaceId: "s1", target: { type: "model_settings", id: "models" }, action: "save_fast_model", label: "添加或修改直觉",
    title: "添加一条直觉", fields: FIELDS,
  });
});

const values = { name: "公司决策", baseUrl: "https://decision.example.com", model: "decision-1", apiKey: SECRET };
const everything = () => JSON.stringify([db.prepare("SELECT * FROM events").all(), db.prepare("SELECT * FROM inbox").all()]);

describe("submitting a form", () => {
  it("passes the checked values to the operation, records the result without the key and wakes Lead", async () => {
    const calls: unknown[] = [];
    const dto = await submitUiForm(db, {
      id: formId, values, locale: "zh", bindingId: 7,
      perform: async (submission) => { calls.push(submission); return { message: "添加了直觉 公司决策（decision.example.com）" }; },
    });
    expect(calls).toEqual([{ target: { type: "model_settings", id: "models" }, action: "save_fast_model", input: values }]);
    expect(dto).toMatchObject({ id: formId, state: "done", result: { ok: true, message: "添加了直觉 公司决策（decision.example.com）" } });
    const wake = listInbox(db).map((row) => ({ ...row, payload: JSON.parse(row.payload) })).find((row) => row.payload.kind === "lead_form_submitted");
    expect(wake?.payload).toMatchObject({ formId, ok: true, wakeLead: true, values: { apiKey: { secret: "set" } } });
    expect(wake?.summary).toContain("添加一条直觉");
    expect(everything()).not.toContain(SECRET);
    // 成功以后不能再交。
    await expect(submitUiForm(db, { id: formId, values, locale: "zh", bindingId: 7, perform: async () => ({ message: "x" }) }))
      .rejects.toMatchObject({ code: "unavailable" });
  });

  it("does nothing when a value is bad", async () => {
    let called = false;
    await expect(submitUiForm(db, {
      id: formId, values: { ...values, baseUrl: "decision.example.com" }, locale: "zh", bindingId: 7,
      perform: async () => { called = true; return { message: "x" }; },
    })).rejects.toBeInstanceOf(UiActionError);
    expect(called).toBe(false);
    expect(uiFormDto(getUiForm(db, formId)!).state).toBe("open");
  });

  it("records a failure with the key scrubbed from the reason, and accepts a fixed retry", async () => {
    const failed = await submitUiForm(db, {
      id: formId, values, locale: "zh", bindingId: 7,
      perform: async () => { throw new Error(`gateway refused key ${SECRET}`); },
    });
    expect(failed).toMatchObject({ state: "failed", result: { ok: false } });
    expect(failed.result!.message).toContain("[secret]");
    expect(everything()).not.toContain(SECRET);
    const retried = await submitUiForm(db, { id: formId, values: { ...values, apiKey: "" }, locale: "zh", bindingId: 7, perform: async () => ({ message: "好了" }) });
    expect(retried.state).toBe("done");
    expect(getUiForm(db, formId)!.submissions.map((entry) => [entry.ok, entry.values.apiKey])).toEqual([
      [false, { secret: "set" }], [true, { secret: "kept" }],
    ]);
  });

  it("runs one submit at a time", async () => {
    let release!: () => void;
    const first = submitUiForm(db, {
      id: formId, values, locale: "zh", bindingId: 7,
      perform: () => new Promise((resolve) => { release = () => resolve({ message: "好了" }); }),
    });
    await expect(submitUiForm(db, { id: formId, values, locale: "zh", bindingId: 7, perform: async () => ({ message: "x" }) }))
      .rejects.toMatchObject({ code: "unavailable" });
    release();
    await expect(first).resolves.toMatchObject({ state: "done" });
  });

  it("does not know a form that render_ui did not create", async () => {
    await expect(submitUiForm(db, { id: "frm_unknown000000", values, locale: "zh", bindingId: 7, perform: async () => ({ message: "x" }) }))
      .rejects.toMatchObject({ code: "not_found" });
  });
});
