// 会话卡片里的表单（工单 #285，protocol 的 ui-forms.ts）：表单记录、提交、叫醒 Lead。
//
//   · createUiForm：render_ui 定稿时，每个 Form 节点建一条记录（ui_form.created，source=lead）：绑定的操作和字段。
//     记录里没有任何敏感值（secret 字段不能有 default）。客户端提交时 daemon 只认这一份，不认客户端传来的字段定义。
//   · submitUiForm：用户在卡片上点了提交（POST /v1/forms/:id/submit，只有用户的凭证能调用）。先用和客户端同一个函数校验，
//     再交给调用方传进来的 perform：网关的 performUserUiAction / performUserTicketAction，也就是设置页的那个函数，
//     以用户本人的身份执行，权限、检查和账本都和设置页一样。这里不自己执行操作。
//     结果（成没成、一句话、提交的值，敏感字段只有状态）记一条 ui_form.submitted（source=user），
//     再写一条叫醒 Lead 的 inbox（和 ChoiceGroup 的决策请求一样）。失败的表单可以改了再交；成功以后不能再交。
//   · 敏感值只在 perform 的 input 里（内存），不进记录、事件、inbox；操作的错误原文里出现了也擦掉（scrubUiFormSecrets）。
import { randomBytes } from "node:crypto";
import {
  UI_FORM_CREATED_KIND, UI_FORM_LIMITS, UI_FORM_SUBMITTED_KIND, maskedUiFormValues, redactSecretText, resolveUiFormSubmission,
  scrubUiFormSecrets, uiFormEntityKey, uiFormValuesText,
  type Locale, type UiFormCreatedPayload, type UiFormDto, type UiFormField, type UiFormSubmittedPayload,
} from "@pi-lead-child/protocol";
import { addInbox, appendEvent, listEvents, type Db } from "@pi-lead-child/store";
import { UiActionError } from "./types.js";

export interface UiFormRecord {
  created: UiFormCreatedPayload;
  createdAt: string;
  // 每次提交，从旧到新。
  submissions: Array<UiFormSubmittedPayload & { at: string }>;
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** 建一条表单记录（render_ui 定稿时调用）。返回表单编号。 */
export function createUiForm(db: Db, input: {
  surfaceId: string;
  target: { type: string; id: string | number };
  action: string;
  label: string;
  title: string | null;
  fields: readonly UiFormField[];
  now?: Date;
}): string {
  const id = `frm_${randomBytes(12).toString("base64url")}`;
  const payload: UiFormCreatedPayload = {
    id, surfaceId: input.surfaceId, target: { ...input.target }, action: input.action, label: input.label,
    title: input.title, fields: input.fields.map((field) => ({ ...field })),
  };
  db.transaction(() => appendEvent(db, {
    source: "lead", kind: UI_FORM_CREATED_KIND, entityKey: uiFormEntityKey(id), level: "record",
    payload: payload as unknown as Record<string, unknown>,
    ...(input.now ? { occurredAt: input.now.toISOString() } : {}),
  }))();
  return id;
}

/** 读一条表单记录。没有时为 null。 */
export function getUiForm(db: Db, id: string): UiFormRecord | null {
  const events = listEvents(db, { entityKey: uiFormEntityKey(id), kind: [UI_FORM_CREATED_KIND, UI_FORM_SUBMITTED_KIND], limit: 1000 });
  const created = events.find((event) => event.kind === UI_FORM_CREATED_KIND);
  if (!created) return null;
  return {
    created: created.payload as unknown as UiFormCreatedPayload,
    createdAt: created.occurredAt,
    submissions: events.filter((event) => event.kind === UI_FORM_SUBMITTED_KIND)
      .map((event) => ({ ...(event.payload as unknown as UiFormSubmittedPayload), at: event.occurredAt })),
  };
}

/** 表单现在的状态（客户端画卡用）。 */
export function uiFormDto(record: UiFormRecord): UiFormDto {
  const last = record.submissions.at(-1) ?? null;
  const done = record.submissions.some((submission) => submission.ok);
  return {
    id: record.created.id,
    state: done ? "done" : last ? "failed" : "open",
    result: last ? { ok: last.ok, message: last.message, at: last.at } : null,
  };
}

// 正在执行的提交：同一个表单同时只跑一次（连点两下不执行两次）。
const inFlight = new Set<string>();

export interface UiFormPerformResult {
  // 一句给用户和 Lead 看的结果（操作的 summary，没有时用操作的名字）。
  message: string;
}

/**
 * 用户提交一个表单。perform 是设置页的那个入口（以用户本人的身份执行这个操作，input 是校验过的值）。
 * 值不合格时抛 invalid_input（什么都不执行，不记）；表单不存在抛 not_found；已经成功提交过抛 unavailable。
 * 操作本身失败时不抛：记成一次失败的提交，返回 failed 的状态，用户可以改了再交。
 */
export async function submitUiForm(db: Db, input: {
  id: string;
  values: Readonly<Record<string, unknown>>;
  locale: Locale;
  bindingId: number | null;
  // reason：账本里这次操作的原因（「在会话卡片的表单「…」里提交」）。
  perform: (submission: {
    target: { type: string; id: string | number }; action: string; input: Record<string, unknown>; reason: string;
  }) => Promise<UiFormPerformResult>;
  now?: () => Date;
  log?: (line: string) => void;
}): Promise<UiFormDto> {
  const record = getUiForm(db, input.id);
  if (!record) throw new UiActionError("not_found", `没有这个表单：${input.id}`);
  if (uiFormDto(record).state === "done") throw new UiActionError("unavailable", "这个表单已经提交过了");
  if (inFlight.has(input.id)) throw new UiActionError("unavailable", "这个表单正在提交");
  const { created } = record;
  const resolved = resolveUiFormSubmission(created.fields, input.values, input.locale);
  if (!resolved.ok) {
    const [param, problem] = Object.entries(resolved.errors)[0]!;
    throw new UiActionError("invalid_input", `${problem}`.trim() || `字段 ${param} 不合格`);
  }
  inFlight.add(input.id);
  let ok: boolean;
  let message: string;
  try {
    const result = await input.perform({
      target: created.target, action: created.action, input: resolved.input,
      reason: `在会话卡片的表单「${created.title ?? created.label}」里提交`,
    });
    ok = true;
    message = result.message;
  } catch (error) {
    ok = false;
    message = error instanceof Error ? error.message : String(error);
  } finally {
    inFlight.delete(input.id);
  }
  // 操作的结果和错误原文可能带着刚填的 key：擦掉，再按通用的规则去掉密钥的样子。
  message = clip(redactSecretText(scrubUiFormSecrets(message, resolved.secretValues)), UI_FORM_LIMITS.result) || created.label;
  const values = maskedUiFormValues(created.fields, resolved.input, resolved.secrets);
  const at = (input.now?.() ?? new Date()).toISOString();
  const payload: UiFormSubmittedPayload = { id: created.id, ok, message, values, bindingId: input.bindingId };
  try {
    db.transaction(() => {
      appendEvent(db, {
        source: "user", kind: UI_FORM_SUBMITTED_KIND, entityKey: uiFormEntityKey(created.id), level: "record",
        payload: payload as unknown as Record<string, unknown>, occurredAt: at,
      });
      wakeLeadWithForm(db, created, payload);
    })();
  } catch (error) {
    // 操作已经做了：记不上不能让提交报错。
    input.log?.(`[ui-form] failed to record ${created.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const after = getUiForm(db, created.id);
  return after ? uiFormDto(after) : { id: created.id, state: ok ? "done" : "failed", result: { ok, message, at } };
}

// 叫醒 Lead（和 ChoiceGroup 的决策请求一样，wakeLead 的 inbox）：哪个表单、成没成、一句结果、填了什么（敏感字段只有状态）。
// 写给 Lead 看，用中文（和别的叫醒说明一样）。
function wakeLeadWithForm(db: Db, created: UiFormCreatedPayload, submitted: UiFormSubmittedPayload): void {
  const name = created.title ? `「${created.title}」` : `「${created.label}」`;
  const values = uiFormValuesText(created.fields, submitted.values, "zh");
  const summary = submitted.ok
    ? `用户在会话卡片的表单${name}里点了提交，${created.label}已经执行：${submitted.message}。填的值：${values || "无"}。请接着做下一步。`
    : `用户在会话卡片的表单${name}里点了提交，${created.label}没有成功：${submitted.message}。填的值：${values || "无"}。`
      + "卡片上写着原因，用户可以改了再交；需要时告诉他怎么改。";
  addInbox(db, {
    dedupScope: uiFormEntityKey(created.id),
    severity: "attention",
    source: "structural",
    summary,
    payload: {
      kind: "lead_form_submitted",
      formId: created.id,
      target: created.target,
      action: created.action,
      ok: submitted.ok,
      values: submitted.values,
      wakeLead: true,
      needsUser: false,
    },
    lossless: true,
  });
}
