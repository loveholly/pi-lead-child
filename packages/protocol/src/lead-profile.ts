// Lead 的名字、人格和互动风格（设置页「Lead → 身份与风格」，2026-10-22）的线上契约。
// - 名字：界面和系统给用户看的文字里，凡是称呼 Lead 的地方都用它（以前写死成 Lead 或 Paimon）。缺省 Paimon。
// - 人格：Lead 是什么性格、说话什么腔调。互动风格：用户希望 Lead 怎样和自己互动（长短、主动程度、称呼……）。
//   两段都是用户写的自由文字，进 Lead 的系统提示词。它们只管语气和方式，改不了纪律、权限和安全规则（lead 的 identity.ts）。
// - 存在 plc.db 的 kv（lead.profile）。读用 tickets:view，改用 tickets:create。Lead 的 update_lead_profile 工具和设置页
//   调同一个函数（engine 的 lead-profile.ts）；Lead 只能在用户这一轮明确要求时代他改。每次修改记一次主人操作（lead.profile）。
// - 变化时网关发 snapshot.required，payload 是 {resource: "lead-profile"}，客户端重新 GET。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const DEFAULT_LEAD_NAME = "Paimon";
export const LEAD_NAME_MAX_LENGTH = 24;
export const LEAD_PROFILE_TEXT_MAX_LENGTH = 1_200;
export const LEAD_PROFILE_RESOURCE = "lead-profile";

export const LeadProfileAuthorSchema = Type.Union([Type.Literal("user"), Type.Literal("lead")]);
export type LeadProfileAuthor = Static<typeof LeadProfileAuthorSchema>;

export const LeadProfileDtoSchema = StrictObject({
  name: Type.String({ minLength: 1, maxLength: LEAD_NAME_MAX_LENGTH }),
  // 空字符串表示没写：Lead 用缺省的说话方式。
  persona: Type.String({ maxLength: LEAD_PROFILE_TEXT_MAX_LENGTH }),
  interactionStyle: Type.String({ maxLength: LEAD_PROFILE_TEXT_MAX_LENGTH }),
  // 最近一次修改。从没改过时都是 null。
  updatedAt: Type.Union([Type.String(), Type.Null()]),
  // user：用户在设置页改的；lead：Lead 在用户的一轮里代他改的。
  updatedBy: Type.Union([LeadProfileAuthorSchema, Type.Null()]),
});
export type LeadProfileDto = Static<typeof LeadProfileDtoSchema>;

export const LeadProfileResponseSchema = StrictObject({ leadProfile: LeadProfileDtoSchema });
export type LeadProfileResponse = Static<typeof LeadProfileResponseSchema>;

// POST /v1/lead/profile：只给要改的字段。长度在这里放宽一点，按整理以后的文字检查（leadProfileProblem）。
export const LeadProfileRequestSchema = StrictObject({
  name: Type.Optional(Type.String({ maxLength: LEAD_NAME_MAX_LENGTH * 4 })),
  persona: Type.Optional(Type.String({ maxLength: LEAD_PROFILE_TEXT_MAX_LENGTH * 2 })),
  interactionStyle: Type.Optional(Type.String({ maxLength: LEAD_PROFILE_TEXT_MAX_LENGTH * 2 })),
});
export type LeadProfileRequest = Static<typeof LeadProfileRequestSchema>;

export type LeadProfileFields = Pick<LeadProfileDto, "name" | "persona" | "interactionStyle">;

export const DEFAULT_LEAD_PROFILE: LeadProfileDto = Object.freeze({
  name: DEFAULT_LEAD_NAME, persona: "", interactionStyle: "", updatedAt: null, updatedBy: null,
});

// 控制字符（换行、制表符以外的）和零宽字符：名字里一个都不要，长文字里去掉。
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/gu;

/** 名字压成一行：去掉控制字符，连续的空白换成一个空格，去掉两头的空白。 */
export function normalizeLeadName(name: string): string {
  return name.replace(CONTROL, "").replace(/\s+/gu, " ").trim();
}

/** 人格和互动风格：去掉控制字符，统一换行，去掉两头的空白。 */
export function normalizeLeadProfileText(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(CONTROL, "").trim();
}

/** 整理一次请求：只留给了的字段。 */
export function normalizeLeadProfileRequest(request: LeadProfileRequest): Partial<LeadProfileFields> {
  return {
    ...(request.name !== undefined ? { name: normalizeLeadName(request.name) } : {}),
    ...(request.persona !== undefined ? { persona: normalizeLeadProfileText(request.persona) } : {}),
    ...(request.interactionStyle !== undefined ? { interactionStyle: normalizeLeadProfileText(request.interactionStyle) } : {}),
  };
}

/** 整理以后的修改有什么问题，用户能看懂的一句话。没有问题时返回 null。 */
export function leadProfileProblem(patch: Partial<LeadProfileFields>): string | null {
  if (patch.name === undefined && patch.persona === undefined && patch.interactionStyle === undefined) {
    return "没有要改的内容";
  }
  if (patch.name !== undefined) {
    if (!patch.name) return "名字不能是空的";
    if ([...patch.name].length > LEAD_NAME_MAX_LENGTH) return `名字最多 ${LEAD_NAME_MAX_LENGTH} 个字`;
  }
  if (patch.persona !== undefined && [...patch.persona].length > LEAD_PROFILE_TEXT_MAX_LENGTH) {
    return `人格最多 ${LEAD_PROFILE_TEXT_MAX_LENGTH} 个字`;
  }
  if (patch.interactionStyle !== undefined && [...patch.interactionStyle].length > LEAD_PROFILE_TEXT_MAX_LENGTH) {
    return `互动风格最多 ${LEAD_PROFILE_TEXT_MAX_LENGTH} 个字`;
  }
  return null;
}

/** 头像上的字：名字的第一个字，拉丁字母大写。 */
export function leadAvatarLabel(name: string): string {
  const first = [...normalizeLeadName(name)][0];
  return first ? first.toLocaleUpperCase() : [...DEFAULT_LEAD_NAME][0]!;
}
