// 会话卡片里的表单（genui 的 Form 组件，工单 #285，2026-11-06）。
//
// Lead 用 render_ui 画一个 Form：绑定操作层里的一个操作（工单操作或者 perform_action 的目标和操作），每个字段填这个操作的一个参数。
// 用户在卡片上填好、点提交，等于用户本人在设置页上做这个操作：daemon 用同一个函数执行（gateway 的 performUserUiAction、
// performUserTicketAction），权限检查、账本和设置页是同一份。不另开执行通道。
//
//   · 字段的类型：text（单行）、textarea（多行）、select（单选，下拉或分段）、multiselect（多选）、switch（开关）、number（数字）、
//     secret（敏感，例如 key）。每个字段有 label、说明、缺省值、是否必填、校验（URL、邮箱、正则、长度、范围）。
//   · 校验：客户端和 daemon 用同一个函数（resolveUiFormSubmission），客户端先校验，daemon 提交前再校验一次。
//   · 敏感字段：值只在客户端输入，随提交请求直接交给 daemon，由操作自己存进保险库（例如 save_fast_model 的 apiKey 存进
//     sealed-secrets）。Lead 不能预填它（没有 default），只能拿到「已设置 / 保留原值 / 没填」。表单记录、账本、事件日志和
//     叫醒 Lead 的那一条里都没有原值（maskedUiFormValues）。只有登记过的敏感参数（UI_ACTION_SECRET_PARAMS）能做成敏感字段，
//     登记过的敏感参数也只能用敏感字段填（Lead 不能把 key 写进普通字段或按钮的 input）。
//   · 「保留现有值」：敏感字段带 keep 时，不填就不传这个参数，操作按「没给就不变」处理。
//   · 只属于用户本人的操作（user_direct，例如 save_fast_model）也能做成表单：只有用户在卡片上点提交才执行（用户的凭证），
//     Lead 用 perform_action 调用照旧被拒绝。表单没有隐藏的参数：要发出的每个参数都是一个字段，用户都看得到（readOnly 的字段
//     显示但不能改，值用 Lead 画卡时写的 default，daemon 只认表单记录里的那一份）。
//   · 表单记录存在事件日志里（ui_form.created、ui_form.submitted），和改规则的确认卡一样，不另建表。
//
// 这个文件只依赖 typebox 和 protocol 自己，companion 也读它。
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { DEFAULT_LOCALE, type Locale } from "./i18n.ts";
import { registerEventKind, type EventKindDefinition } from "./events.ts";
import { uiFormMessages } from "./ui-forms.messages.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const UI_FORM_LIMITS = {
  fields: 12,
  options: 12,
  label: 40,
  help: 200,
  placeholder: 80,
  // 一个文字字段最多多少字（单行、多行、敏感都一样）。正则只在不超过它的值上跑。
  text: 4_000,
  optionValue: 64,
  pattern: 200,
  title: 120,
  description: 300,
  submitLabel: 20,
  message: 120,
  result: 500,
} as const;

export const UI_FORM_FIELD_KINDS = ["text", "textarea", "select", "multiselect", "switch", "number", "secret"] as const;
export type UiFormFieldKind = typeof UI_FORM_FIELD_KINDS[number];

const FormOptionSchema = StrictObject({
  value: Type.String({ minLength: 1, maxLength: UI_FORM_LIMITS.optionValue }),
  label: Type.String({ minLength: 1, maxLength: UI_FORM_LIMITS.label }),
});

const FormValidateSchema = StrictObject({
  // 文字字段：url（http:// 或 https:// 开头的地址）、email。
  format: Type.Optional(Type.Union([Type.Literal("url"), Type.Literal("email")])),
  // 文字字段：整个值要匹配的正则（JavaScript 写法，不带斜杠）。
  pattern: Type.Optional(Type.String({ minLength: 1, maxLength: UI_FORM_LIMITS.pattern })),
  minLength: Type.Optional(Type.Integer({ minimum: 0, maximum: UI_FORM_LIMITS.text })),
  maxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: UI_FORM_LIMITS.text })),
  // 数字字段。
  min: Type.Optional(Type.Number()),
  max: Type.Optional(Type.Number()),
  integer: Type.Optional(Type.Boolean()),
  // 多选字段。
  minItems: Type.Optional(Type.Integer({ minimum: 0, maximum: UI_FORM_LIMITS.options })),
  maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: UI_FORM_LIMITS.options })),
  // 不合格时代替缺省说法的一句话。
  message: Type.Optional(Type.String({ minLength: 1, maxLength: UI_FORM_LIMITS.message })),
});
export type UiFormValidate = Static<typeof FormValidateSchema>;

export const UiFormFieldSchema = StrictObject({
  // 填给绑定的操作的哪个参数。
  param: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,39}$" }),
  // 写成显式的字面量：从 Union(…map(Literal)) 推出来的类型丢了字面量。
  kind: Type.Union([
    Type.Literal("text"), Type.Literal("textarea"), Type.Literal("select"), Type.Literal("multiselect"),
    Type.Literal("switch"), Type.Literal("number"), Type.Literal("secret"),
  ]),
  label: Type.String({ minLength: 1, maxLength: UI_FORM_LIMITS.label }),
  help: Type.Optional(Type.String({ minLength: 1, maxLength: UI_FORM_LIMITS.help })),
  placeholder: Type.Optional(Type.String({ minLength: 1, maxLength: UI_FORM_LIMITS.placeholder })),
  required: Type.Optional(Type.Boolean()),
  // 显示但不能改：值是 default。
  readOnly: Type.Optional(Type.Boolean()),
  default: Type.Optional(Type.Union([
    Type.String({ maxLength: UI_FORM_LIMITS.text }),
    Type.Number(),
    Type.Boolean(),
    Type.Array(Type.String({ minLength: 1, maxLength: UI_FORM_LIMITS.optionValue }), { maxItems: UI_FORM_LIMITS.options }),
  ])),
  // 单选、多选的选项。
  options: Type.Optional(Type.Array(FormOptionSchema, { minItems: 1, maxItems: UI_FORM_LIMITS.options })),
  // 单选的样子：dropdown（下拉，缺省）或 segmented（分段，最多 4 项）。
  display: Type.Optional(Type.Union([Type.Literal("dropdown"), Type.Literal("segmented")])),
  // 只对敏感字段：已经设置过，不填就保留现有的值。
  keep: Type.Optional(Type.Boolean()),
  validate: Type.Optional(FormValidateSchema),
});
export type UiFormField = Static<typeof UiFormFieldSchema>;

// 分段控件最多几段：再多就放不下一行。
export const UI_FORM_SEGMENTED_MAX = 4;

// ── 敏感参数 ────────────────────────────────────────────────────────────────────

// 操作层里带密钥的参数（目标类型 → 操作 → 参数）。只有这些参数能做成敏感字段，它们也只能用敏感字段填。
// 新的带密钥的操作在这里登记一行。工单操作没有带密钥的参数。
export const UI_ACTION_SECRET_PARAMS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  model_settings: {
    save_provider: ["apiKey"],
    save_fast_model: ["apiKey"],
  },
};

/** 这个操作的这个参数是不是密钥。 */
export function isSecretActionParam(targetType: string, action: string, param: string): boolean {
  return UI_ACTION_SECRET_PARAMS[targetType]?.[action]?.includes(param) ?? false;
}

// ── 字段本身的规则（画卡时查，和值无关）────────────────────────────────────────────

const TEXT_KINDS: ReadonlySet<UiFormFieldKind> = new Set(["text", "textarea", "secret"]);

// 嵌套的量词（例如 (a+)+、(\w*)*）在不匹配的长输入上会回溯很久。正则来自 Lead，daemon 也要跑它，所以不收这类写法和反向引用。
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/;
const BACKREFERENCE = /\\[1-9]|\\k</;

/** 正则能不能用：写法对、不太长、没有嵌套的量词和反向引用。能用时为 null。 */
export function uiFormPatternProblem(pattern: string): string | null {
  if (pattern.length > UI_FORM_LIMITS.pattern) return `正则超过 ${UI_FORM_LIMITS.pattern} 个字符`;
  if (NESTED_QUANTIFIER.test(pattern)) return "正则里有嵌套的量词（例如 (a+)+），换一种不会反复回溯的写法";
  if (BACKREFERENCE.test(pattern)) return "正则里不能有反向引用";
  try {
    new RegExp(pattern, "u");
  } catch (error) {
    return `正则写法不对：${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

/** 一个字段自己的规则（schema 表达不了的部分）。返回 [相对于字段的路径, 问题]；没问题时为 null。给 Lead 看，用中文。 */
export function uiFormFieldRuleProblem(field: UiFormField): [string, string] | null {
  const choice = field.kind === "select" || field.kind === "multiselect";
  if (choice && !field.options) return ["/options", `${field.kind} 字段要有 options`];
  if (!choice && field.options) return ["/options", `只有 select、multiselect 字段能有 options`];
  if (field.options) {
    const values = field.options.map((option) => option.value);
    if (new Set(values).size !== values.length) return ["/options", "选项的 value 重复"];
  }
  if (field.display !== undefined && field.kind !== "select") return ["/display", "只有 select 字段能选 display"];
  if (field.display === "segmented" && (field.options?.length ?? 0) > UI_FORM_SEGMENTED_MAX) {
    return ["/display", `分段最多 ${UI_FORM_SEGMENTED_MAX} 项，选项更多时用 dropdown`];
  }
  if (field.keep !== undefined && field.kind !== "secret") return ["/keep", "只有 secret 字段能带 keep"];
  if (field.kind === "secret") {
    if (field.default !== undefined) return ["/default", "secret 字段不能有缺省值：敏感的值只能由用户自己填"];
    if (field.readOnly) return ["/readOnly", "secret 字段不能是 readOnly"];
  }
  if (field.readOnly && field.default === undefined) return ["/default", "readOnly 字段要有 default（它就是提交的值）"];
  const validate = field.validate ?? {};
  const textOnly = ["format", "pattern", "minLength", "maxLength"] as const;
  const numberOnly = ["min", "max", "integer"] as const;
  const listOnly = ["minItems", "maxItems"] as const;
  const misplaced = [
    ...(TEXT_KINDS.has(field.kind) ? [] : textOnly),
    ...(field.kind === "number" ? [] : numberOnly),
    ...(field.kind === "multiselect" ? [] : listOnly),
  ].find((key) => validate[key] !== undefined);
  if (misplaced) return [`/validate/${misplaced}`, `${field.kind} 字段不能用 validate.${misplaced}`];
  if (validate.pattern !== undefined) {
    const problem = uiFormPatternProblem(validate.pattern);
    if (problem) return ["/validate/pattern", problem];
  }
  if (validate.minLength !== undefined && validate.maxLength !== undefined && validate.minLength > validate.maxLength) {
    return ["/validate", "minLength 大于 maxLength"];
  }
  if (validate.min !== undefined && validate.max !== undefined && validate.min > validate.max) return ["/validate", "min 大于 max"];
  if (validate.minItems !== undefined && validate.maxItems !== undefined && validate.minItems > validate.maxItems) {
    return ["/validate", "minItems 大于 maxItems"];
  }
  if (field.default !== undefined) {
    const problem = uiFormFieldValueProblem(field, field.default, "zh", { ignoreRequired: true });
    if (problem) return ["/default", `缺省值不合格：${problem}`];
  }
  return null;
}

// ── 值的校验（客户端和 daemon 同一个函数）──────────────────────────────────────────

export type UiFormValue = string | number | boolean | string[];

/** 这个值算不算没填。开关总算填了。 */
export function isEmptyUiFormValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

const URL_VALUE = /^https?:\/\/[^\s/?#]+[^\s]*$/;
const EMAIL_VALUE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/;

/**
 * 一个字段的值合不合格。合格时为 null；不合格时是给用户看的一句话（按 locale）。
 * ignoreRequired：不查必填（画卡时查缺省值用）。
 */
export function uiFormFieldValueProblem(
  field: UiFormField, value: unknown, locale: Locale = DEFAULT_LOCALE, options: { ignoreRequired?: boolean } = {},
): string | null {
  const m = uiFormMessages(locale);
  const custom = field.validate?.message;
  if (isEmptyUiFormValue(value)) {
    if (options.ignoreRequired || !field.required) return null;
    if (field.kind === "secret" && field.keep) return null;
    return m.required(field.label);
  }
  const validate = field.validate ?? {};
  switch (field.kind) {
    case "text":
    case "textarea":
    case "secret": {
      if (typeof value !== "string") return m.wrongType(field.label);
      const text = field.kind === "secret" ? value : value.trim();
      if (text.length > UI_FORM_LIMITS.text) return custom ?? m.tooLong(field.label, UI_FORM_LIMITS.text);
      if (field.kind === "text" && /[\r\n]/.test(text)) return custom ?? m.oneLine(field.label);
      if (validate.minLength !== undefined && text.length < validate.minLength) return custom ?? m.tooShort(field.label, validate.minLength);
      if (validate.maxLength !== undefined && text.length > validate.maxLength) return custom ?? m.tooLong(field.label, validate.maxLength);
      if (validate.format === "url" && !URL_VALUE.test(text)) return custom ?? m.notUrl(field.label);
      if (validate.format === "email" && !EMAIL_VALUE.test(text)) return custom ?? m.notEmail(field.label);
      if (validate.pattern !== undefined) {
        if (uiFormPatternProblem(validate.pattern)) return custom ?? m.notMatching(field.label);
        if (!new RegExp(`^(?:${validate.pattern})$`, "u").test(text)) return custom ?? m.notMatching(field.label);
      }
      return null;
    }
    case "select": {
      if (typeof value !== "string" || !field.options?.some((option) => option.value === value)) return m.notAnOption(field.label);
      return null;
    }
    case "multiselect": {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return m.wrongType(field.label);
      const picked = value as string[];
      if (picked.some((entry) => !field.options?.some((option) => option.value === entry))) return m.notAnOption(field.label);
      if (new Set(picked).size !== picked.length) return m.notAnOption(field.label);
      if (validate.minItems !== undefined && picked.length < validate.minItems) return custom ?? m.tooFew(field.label, validate.minItems);
      if (validate.maxItems !== undefined && picked.length > validate.maxItems) return custom ?? m.tooMany(field.label, validate.maxItems);
      return null;
    }
    case "switch":
      return typeof value === "boolean" ? null : m.wrongType(field.label);
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return m.notNumber(field.label);
      if (validate.integer && !Number.isInteger(value)) return custom ?? m.notInteger(field.label);
      if (validate.min !== undefined && value < validate.min) return custom ?? m.tooSmall(field.label, validate.min);
      if (validate.max !== undefined && value > validate.max) return custom ?? m.tooLarge(field.label, validate.max);
      return null;
    }
  }
  return m.wrongType(field.label);
}

/** 字段的初始值：default，没有时按类型给空值（开关是 false）。敏感字段总是空的。 */
export function initialUiFormValue(field: UiFormField): UiFormValue | undefined {
  if (field.kind === "secret") return "";
  if (field.default !== undefined) return field.default;
  if (field.kind === "switch") return false;
  if (field.kind === "multiselect") return [];
  if (field.kind === "number") return undefined;
  return "";
}

// 一个敏感字段这次怎么了：set 填了新的值；kept 没填，保留现有的值；empty 没填（也没有现有的值可保留）。
export type UiFormSecretState = "set" | "kept" | "empty";

export type UiFormSubmission =
  | {
    ok: true;
    // 交给操作的 input：没填的参数不放进去（操作按「没给就不变」处理）。含敏感值，只在内存里交给操作，不存、不记。
    input: Record<string, unknown>;
    // 敏感字段这次的状态。
    secrets: Record<string, UiFormSecretState>;
    // 这次填进去的敏感值（给调用方从错误文字里擦掉它们用）。
    secretValues: string[];
  }
  | { ok: false; errors: Record<string, string> };

/**
 * 校验用户填的值，拼出操作的 input。readOnly 字段用 default，不看用户给的值。values 里有表单没有的字段时不合格。
 * 文字（单行、多行）去掉首尾空白；敏感值原样。
 */
export function resolveUiFormSubmission(
  fields: readonly UiFormField[], values: Readonly<Record<string, unknown>>, locale: Locale = DEFAULT_LOCALE,
): UiFormSubmission {
  const m = uiFormMessages(locale);
  const errors: Record<string, string> = {};
  const known = new Set(fields.map((field) => field.param));
  for (const param of Object.keys(values)) if (!known.has(param)) errors[param] = m.unknownField(param);
  const input: Record<string, unknown> = {};
  const secrets: Record<string, UiFormSecretState> = {};
  const secretValues: string[] = [];
  for (const field of fields) {
    const raw = field.readOnly ? field.default : values[field.param];
    const problem = uiFormFieldValueProblem(field, raw, locale);
    if (problem) {
      errors[field.param] = problem;
      continue;
    }
    if (field.kind === "secret") {
      const given = typeof raw === "string" && raw.length > 0 ? raw : null;
      secrets[field.param] = given ? "set" : field.keep ? "kept" : "empty";
      if (given) {
        input[field.param] = given;
        secretValues.push(given);
      }
      continue;
    }
    if (isEmptyUiFormValue(raw)) continue;
    input[field.param] = typeof raw === "string" ? raw.trim() : raw;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, input, secrets, secretValues };
}

/** 交给操作的 input 去掉敏感值：敏感参数换成它的状态（set、kept、empty）。给账本、事件和 Lead 用。 */
export function maskedUiFormValues(
  fields: readonly UiFormField[], input: Readonly<Record<string, unknown>>, secrets: Readonly<Record<string, UiFormSecretState>>,
): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.kind === "secret") masked[field.param] = { secret: secrets[field.param] ?? "empty" };
    else if (input[field.param] !== undefined) masked[field.param] = input[field.param];
  }
  return masked;
}

/** 从一段文字里擦掉这次填的敏感值（操作的错误原文可能带着它）。 */
export function scrubUiFormSecrets(text: string, secretValues: readonly string[]): string {
  let clean = text;
  for (const value of secretValues) if (value.length >= 4) clean = clean.split(value).join("[secret]");
  return clean;
}

// ── 表单记录和接口 ──────────────────────────────────────────────────────────────

export const UI_FORM_ID_PATTERN = "^frm_[A-Za-z0-9_-]{8,40}$";
export const UiFormIdSchema = Type.String({ pattern: UI_FORM_ID_PATTERN });
export const uiFormEntityKey = (id: string) => `ui_form:${id}`;

// 表单现在的状态：open 还没提交过；failed 最近一次提交失败了（可以改了再交）；done 提交成功（卡片收成一行结果）。
export const UiFormStateSchema = Type.Union([Type.Literal("open"), Type.Literal("failed"), Type.Literal("done")]);
export type UiFormState = Static<typeof UiFormStateSchema>;

export const UiFormDtoSchema = StrictObject({
  id: UiFormIdSchema,
  state: UiFormStateSchema,
  // 最近一次提交的结果。没提交过时为 null。message 是一句话：成功时是操作的结果，失败时是原因。
  result: Nullable(StrictObject({
    ok: Type.Boolean(),
    message: Type.String({ maxLength: UI_FORM_LIMITS.result }),
    at: Type.String({ minLength: 10, maxLength: 40 }),
  })),
});
export type UiFormDto = Static<typeof UiFormDtoSchema>;

export const UiFormResponseSchema = StrictObject({ form: UiFormDtoSchema });
export type UiFormResponse = Static<typeof UiFormResponseSchema>;

// POST /v1/forms/:id/submit 的请求体：每个字段的值，按 param。
export const UiFormSubmitRequestSchema = StrictObject({
  values: Type.Record(Type.String({ maxLength: 40 }), Type.Unknown()),
});
export type UiFormSubmitRequest = Static<typeof UiFormSubmitRequestSchema>;

// ── 事件 ────────────────────────────────────────────────────────────────────────

export const UI_FORM_CREATED_KIND = "ui_form.created";
export const UI_FORM_SUBMITTED_KIND = "ui_form.submitted";

const FormTargetSchema = Type.Object({
  type: Type.String({ minLength: 1 }),
  id: Type.Union([Type.String({ minLength: 1 }), Type.Integer({ minimum: 1 })]),
});

export const UiFormCreatedPayloadSchema = Type.Object({
  id: UiFormIdSchema,
  surfaceId: Type.String({ minLength: 1 }),
  target: FormTargetSchema,
  action: Type.String({ minLength: 1 }),
  // 操作的名字（操作层的 label），给叫醒 Lead 的那一句用。
  label: Type.String(),
  title: Nullable(Type.String()),
  fields: Type.Array(UiFormFieldSchema, { minItems: 1, maxItems: UI_FORM_LIMITS.fields }),
});
export type UiFormCreatedPayload = Static<typeof UiFormCreatedPayloadSchema>;

export const UiFormSubmittedPayloadSchema = Type.Object({
  id: UiFormIdSchema,
  ok: Type.Boolean(),
  message: Type.String({ maxLength: UI_FORM_LIMITS.result }),
  // 提交的值，敏感字段只有状态（maskedUiFormValues）。
  values: Type.Record(Type.String(), Type.Unknown()),
  bindingId: Nullable(Type.Integer()),
});
export type UiFormSubmittedPayload = Static<typeof UiFormSubmittedPayloadSchema>;

export const UI_FORM_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    kind: UI_FORM_CREATED_KIND,
    sources: ["lead"],
    payload: UiFormCreatedPayloadSchema,
    description: "Lead 在会话卡片里画了一个表单：绑定的操作和字段（没有任何敏感值）。",
  },
  {
    kind: UI_FORM_SUBMITTED_KIND,
    sources: ["user"],
    waitSignal: "user_action",
    payload: UiFormSubmittedPayloadSchema,
    description: "用户在会话卡片的表单上点了提交：成没成、一句结果、提交的值（敏感字段只有状态）。",
  },
];

for (const definition of UI_FORM_EVENT_KINDS) registerEventKind(definition);

/** 给 Lead 看的一行：每个字段填了什么。敏感字段只写状态。 */
export function uiFormValuesText(fields: readonly UiFormField[], masked: Readonly<Record<string, unknown>>, locale: Locale = DEFAULT_LOCALE): string {
  const m = uiFormMessages(locale);
  const parts: string[] = [];
  for (const field of fields) {
    const value = masked[field.param];
    if (field.kind === "secret") {
      const state = (value as { secret?: UiFormSecretState } | undefined)?.secret ?? "empty";
      parts.push(`${field.label}（${field.param}）=${m.secretState[state]}`);
      continue;
    }
    if (value === undefined) continue;
    const shown = field.options && typeof value === "string"
      ? field.options.find((option) => option.value === value)?.label ?? value
      : Array.isArray(value) ? value.join(", ") : String(value);
    parts.push(`${field.label}（${field.param}）=${shown}`);
  }
  return parts.join("；");
}
