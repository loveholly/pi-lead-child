// 会话卡片里的表单（工单 #285，ui-forms.ts）：Form 的 schema 校验、字段和值的规则、敏感字段的规则。
// 客户端和 daemon 用同一个 resolveUiFormSubmission：这里守住它。
import { describe, expect, it } from "vitest";
import {
  UI_CATALOG_VERSION, maskedUiFormValues, partialUiSurface, resolveUiFormSubmission, scrubUiFormSecrets, uiFormFieldValueProblem,
  uiFormPatternProblem, uiFormValuesText, validateUiSurface,
  type UiFormField, type UiNode,
} from "../src/index.ts";

const surface = (nodes: UiNode[], root = nodes[0]!.id) => ({ id: "s1", catalogVersion: UI_CATALOG_VERSION, root, fallbackText: "填表", nodes });
const form = (props: Record<string, unknown>): UiNode => ({
  id: "form", type: "Form",
  props: { target: { type: "model_settings", id: "models" }, action: "save_fast_model", ...props },
});
const FAST_FIELDS: UiFormField[] = [
  { param: "name", kind: "text", label: "名字", default: "公司决策", required: true },
  { param: "baseUrl", kind: "text", label: "地址", required: true, validate: { format: "url" } },
  { param: "model", kind: "text", label: "模型", default: "decision-1", required: true },
  { param: "apiKey", kind: "secret", label: "Key", required: true },
];
const errorOf = (input: unknown) => {
  const checked = validateUiSurface(input);
  return checked.ok ? null : checked.errors[0]!.message;
};

describe("Form in the component catalog", () => {
  it("accepts a form bound to save_fast_model with a secret key field", () => {
    expect(validateUiSurface(surface([form({ fields: FAST_FIELDS })])).ok).toBe(true);
  });

  it("accepts every field kind on a ticket action", () => {
    const fields: UiFormField[] = [
      { param: "runtime", kind: "select", label: "执行器", display: "segmented", options: [{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }] },
      { param: "model", kind: "text", label: "模型", validate: { pattern: "[a-z0-9-]{1,40}", message: "只能有小写字母、数字和 -" } },
    ];
    expect(errorOf(surface([{ id: "form", type: "Form", props: { target: { type: "ticket", id: 5 }, action: "start", fields } }]))).toBeNull();
  });

  it("rejects a field for a parameter the operation does not have, and a missing required parameter", () => {
    expect(errorOf(surface([form({ fields: [...FAST_FIELDS, { param: "colour", kind: "text", label: "颜色" }] })]))).toMatch(/没有参数 colour/);
    expect(errorOf(surface([form({ fields: FAST_FIELDS.filter((field) => field.param !== "baseUrl") })]))).toMatch(/必填参数 baseUrl/);
  });

  it("only lets a registered key parameter be a secret field, and a key parameter only be a secret field", () => {
    const asText = FAST_FIELDS.map((field) => (field.param === "apiKey" ? { ...field, kind: "text" as const } : field));
    expect(errorOf(surface([form({ fields: asText })]))).toMatch(/apiKey 是密钥/);
    const nameSecret = FAST_FIELDS.map((field) => (field.param === "name" ? { param: "name", kind: "secret" as const, label: "名字" } : field));
    expect(errorOf(surface([form({ fields: nameSecret })]))).toMatch(/不是登记过的密钥参数/);
  });

  it("refuses a default on a secret field: Lead cannot prefill a key", () => {
    const prefilled = FAST_FIELDS.map((field) => (field.param === "apiKey" ? { ...field, default: "sk-123" } : field));
    expect(errorOf(surface([form({ fields: prefilled })]))).toMatch(/secret 字段不能有缺省值/);
  });

  it("refuses a key written into a button's input", () => {
    const button: UiNode = {
      id: "save", type: "Action",
      props: { target: { type: "model_settings", id: "models" }, action: "save_fast_model", role: "primary", input: { apiKey: "sk-123" } },
    };
    expect(errorOf(surface([button]))).toMatch(/apiKey 是密钥/);
  });

  it("checks field rules that the schema cannot express", () => {
    const withFields = (fields: unknown[]) => errorOf(surface([form({ fields: [...FAST_FIELDS, ...fields] })]));
    // 「name」重复。
    expect(errorOf(surface([form({ fields: [...FAST_FIELDS, FAST_FIELDS[0]] })]))).toMatch(/两个字段填同一个参数 name/);
    expect(withFields([{ param: "id", kind: "select", label: "编号" }])).toMatch(/要有 options/);
    expect(withFields([{ param: "id", kind: "text", label: "编号", readOnly: true }])).toMatch(/readOnly 字段要有 default/);
    expect(withFields([{ param: "id", kind: "text", label: "编号", validate: { min: 1 } }])).toMatch(/不能用 validate.min/);
    expect(withFields([{ param: "id", kind: "text", label: "编号", validate: { pattern: "(a+)+" } }])).toMatch(/嵌套的量词/);
    expect(withFields([{ param: "id", kind: "text", label: "编号", default: "Bad Id!" }])).toMatch(/缺省值不是 id 能取的值/);
  });

  it("allows one form per card, as the card's only primary, and not inside a Disclosure or Group", () => {
    const two = surface([
      { id: "box", type: "Stack", props: {}, children: ["form", "form2"] },
      form({ fields: FAST_FIELDS }),
      { ...form({ fields: FAST_FIELDS }), id: "form2" },
    ]);
    expect(errorOf(two)).toMatch(/最多 1 个 Form/);
    const withPrimary = surface([
      { id: "box", type: "Stack", props: {}, children: ["form", "go"] },
      form({ fields: FAST_FIELDS }),
      { id: "go", type: "Action", props: { target: { type: "model_settings", id: "models" }, action: "set_fast_chain", role: "primary", input: { chain: [] } } },
    ]);
    expect(errorOf(withPrimary)).toMatch(/primary/);
    const hidden = surface([
      { id: "box", type: "Disclosure", props: { label: "更多", detail: ["form"] }, children: ["head", "form"] },
      { id: "head", type: "Text", props: { text: "改直觉" } },
      form({ fields: FAST_FIELDS }),
    ]);
    expect(errorOf(hidden)).toMatch(/不能放进 Disclosure/);
  });

  it("drops the server-filled form id while the card is still streaming", () => {
    const args = { root: "form", fallback_text: "填表", nodes: [form({ fields: FAST_FIELDS, form: "frm_forged000000" })] };
    const partial = partialUiSurface(args, "call-1");
    expect(partial?.nodes[0]!.props).not.toHaveProperty("form");
  });
});

describe("form values: the same check on the client and in the daemon", () => {
  it("reports required, url, length, pattern, number and list problems", () => {
    const url: UiFormField = { param: "baseUrl", kind: "text", label: "地址", required: true, validate: { format: "url" } };
    expect(uiFormFieldValueProblem(url, "", "zh")).toBe("请填写地址。");
    expect(uiFormFieldValueProblem(url, "decision.example.com", "zh")).toMatch(/http:\/\//);
    expect(uiFormFieldValueProblem(url, "https://decision.example.com", "zh")).toBeNull();
    const short: UiFormField = { param: "name", kind: "text", label: "名字", validate: { minLength: 3, maxLength: 5 } };
    expect(uiFormFieldValueProblem(short, "ab", "en")).toMatch(/at least 3/);
    expect(uiFormFieldValueProblem(short, "abcdef", "en")).toMatch(/at most 5/);
    expect(uiFormFieldValueProblem({ ...short, kind: "text" }, "a\nb", "zh")).toMatch(/一行/);
    const pattern: UiFormField = { param: "model", kind: "text", label: "模型", validate: { pattern: "[a-z]+-\\d", message: "写成 decision-1 这样" } };
    expect(uiFormFieldValueProblem(pattern, "decision-1", "zh")).toBeNull();
    // 整串匹配：前后多了字也不行。
    expect(uiFormFieldValueProblem(pattern, "xx decision-1", "zh")).toBe("写成 decision-1 这样");
    const count: UiFormField = { param: "n", kind: "number", label: "次数", validate: { integer: true, min: 1, max: 5 } };
    expect(uiFormFieldValueProblem(count, 2.5, "zh")).toMatch(/整数/);
    expect(uiFormFieldValueProblem(count, 9, "zh")).toMatch(/不能大于 5/);
    expect(uiFormFieldValueProblem(count, "3", "zh")).toMatch(/要是数字/);
    const pick: UiFormField = { param: "tags", kind: "multiselect", label: "标签", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], validate: { maxItems: 1 } };
    expect(uiFormFieldValueProblem(pick, ["a", "c"], "zh")).toMatch(/从列表里选/);
    expect(uiFormFieldValueProblem(pick, ["a", "b"], "zh")).toMatch(/最多选 1 项/);
    expect(uiFormFieldValueProblem({ param: "on", kind: "switch", label: "开关" }, "yes", "zh")).toMatch(/类型不对/);
  });

  it("builds the operation's input, keeps an existing secret when the field is empty, and masks secrets", () => {
    const fields: UiFormField[] = [
      { param: "id", kind: "text", label: "编号", readOnly: true, default: "corp" },
      ...FAST_FIELDS.filter((field) => field.param !== "apiKey"),
      { param: "apiKey", kind: "secret", label: "Key", required: true, keep: true },
    ];
    // readOnly 的值来自字段定义：客户端传来的不算。
    const kept = resolveUiFormSubmission(fields, { id: "other", name: " 公司决策 ", baseUrl: "https://d.example.com", model: "decision-1", apiKey: "" });
    expect(kept).toEqual({
      ok: true, input: { id: "corp", name: "公司决策", baseUrl: "https://d.example.com", model: "decision-1" },
      secrets: { apiKey: "kept" }, secretValues: [],
    });
    const set = resolveUiFormSubmission(fields, { name: "公司决策", baseUrl: "https://d.example.com", model: "decision-1", apiKey: "tsk-abc-123" });
    expect(set.ok && set.input.apiKey).toBe("tsk-abc-123");
    const masked = set.ok ? maskedUiFormValues(fields, set.input, set.secrets) : {};
    expect(masked).toEqual({ id: "corp", name: "公司决策", baseUrl: "https://d.example.com", model: "decision-1", apiKey: { secret: "set" } });
    expect(JSON.stringify(masked)).not.toContain("tsk-abc-123");
    expect(uiFormValuesText(fields, masked, "zh")).toContain("Key（apiKey）=已设置（新的值）");
    expect(scrubUiFormSecrets("HTTP 401 for key tsk-abc-123", ["tsk-abc-123"])).toBe("HTTP 401 for key [secret]");
  });

  it("refuses values for fields the form does not have, and reports every bad field", () => {
    const result = resolveUiFormSubmission(FAST_FIELDS, { name: "", baseUrl: "nope", model: "decision-1", apiKey: "k", extra: 1 }, "zh");
    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.errors).sort()).toEqual(["baseUrl", "extra", "name"]);
  });

  it("refuses regular expressions that could backtrack for a long time", () => {
    expect(uiFormPatternProblem("(\\w+)*$")).toMatch(/嵌套/);
    expect(uiFormPatternProblem("(a)\\1")).toMatch(/反向引用/);
    expect(uiFormPatternProblem("[")).toMatch(/写法不对/);
    expect(uiFormPatternProblem("[A-Za-z0-9._-]{1,64}")).toBeNull();
  });
});
