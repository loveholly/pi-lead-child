// 设置 → Lead → 身份与风格（2026-10-22）的文字和表单规则。页面在 LeadProfileSection.tsx。
import {
  leadProfileProblem, normalizeLeadProfileRequest,
  type LeadProfileDto, type LeadProfileFields, type LeadProfileRequest,
} from '@pi-lead-child/protocol';

import { formatConversationDate, formatConversationTime } from '@/features/chat/conversationTime';

export type LeadProfileForm = { name: string; persona: string; interactionStyle: string };

export function leadProfileDescription(name: string): string {
  return `${name} 叫什么、是什么性格、怎样和你互动。保存以后马上生效：界面上的称呼立即换，${name} 从下一轮对话起按新的说话。`;
}

export const LEAD_NAME_HELP = '界面、通知和它的自我介绍都用这个名字。';
export const PERSONA_HELP = '它的性格、腔调和说话习惯。不写时用缺省的：简洁直接。';
export const INTERACTION_STYLE_HELP = '你希望它怎样和你互动：回复长短、主动程度、怎么称呼你、什么时候打扰你。';
export const PERSONA_PLACEHOLDER = '例如：沉稳干练的管家，偶尔幽默；不用感叹号，不说客套话。';
export const INTERACTION_STYLE_PLACEHOLDER = '例如：先给结论，最多三句；叫我 Leo；拿不准时先问我，别猜。';

export function leadProfileBoundaryNote(name: string): string {
  return `这两段只决定语气和互动方式，改不了 ${name} 的权限和安全规则。也可以直接在对话里说「以后叫你……」「回复短一点」，${name} 会改这里。`;
}

/** 这次要发的修改：只带改了的字段（按整理以后的文字比较）。没有改时返回 null。 */
export function leadProfileChanges(form: LeadProfileForm, saved: LeadProfileFields): Partial<LeadProfileFields> | null {
  const next = normalizeLeadProfileRequest(form);
  const request: Partial<LeadProfileFields> = {};
  if (next.name !== saved.name) request.name = next.name;
  if (next.persona !== saved.persona) request.persona = next.persona;
  if (next.interactionStyle !== saved.interactionStyle) request.interactionStyle = next.interactionStyle;
  return Object.keys(request).length ? request : null;
}

/** 保存之前的检查：有问题时返回用户能看懂的一句话。 */
export function leadProfileFormProblem(request: LeadProfileRequest): string | null {
  return leadProfileProblem(normalizeLeadProfileRequest(request));
}

/** 「最近一次修改」那一行。从没改过时返回 null。 */
export function leadProfileUpdatedLine(profile: LeadProfileDto, now: Date): string | null {
  if (!profile.updatedAt) return null;
  const when = `${formatConversationDate(profile.updatedAt, now)} ${formatConversationTime(profile.updatedAt)}`.trim();
  const who = profile.updatedBy === 'lead' ? `${profile.name} 在对话里按你的要求改的` : '你改的';
  return `最近一次修改：${when}，${who}。`;
}
