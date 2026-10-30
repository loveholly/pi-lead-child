// Lead 改自己的名字、人格和互动风格：update_lead_profile（2026-10-22）。
// 和设置页「身份与风格」调同一个函数（engine 的 updateLeadProfile）：同样的校验，同样的主人操作。
// 权限是 user_only：只有用户在这一轮明确要求时才能改（凭当前已认证的配对用户轮次，Lead 改不了它）。
// 现在的值不用工具读：系统提示的 identity 一节每一轮都写着（identity.ts）。
// 形象（2026-10-28）：set_lead_avatar 和设置 → 身份与风格 → 形象调同一组函数（engine 的 lead-avatar.ts），权限一样。
// 它没有 FairyEye 的参数：用户的底线是只有他自己在 Lead 的会话里发 `/fairyeye on` 才能打开（daemon 的命令）。
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  CHAT_IMAGE_ID_PATTERN, LEAD_AVATAR_SLOTS, LEAD_NAME_MAX_LENGTH, LEAD_PROFILE_TEXT_MAX_LENGTH, SLACK_BYLINE_EMOJI_MAX_LENGTH,
  type LeadAvatarSlot, type LeadProfileRequest,
} from "@pi-lead-child/protocol";
import {
  clearLeadAvatarSlot, LeadAvatarError, LeadProfileError, setLeadAvatarSlackEmoji, setLeadAvatarSlot, updateLeadProfile,
  type LeadAvatarOutcome,
} from "@pi-lead-child/engine";
import { getChatImage, publishGatewayEvents, type Db } from "@pi-lead-child/store";
import { authorityTurnId, turnOriginOf, type LeadTurnOrigin } from "./turn-origin.js";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: {} };
}

interface ProfileParams {
  name?: string;
  persona?: string;
  interaction_style?: string;
}

interface AvatarParams {
  slot?: LeadAvatarSlot;
  chat_image_id?: string;
  clear?: boolean;
  slack_emoji?: string;
  reset_slack_emoji?: boolean;
}

const SLOT_LABELS: Record<LeadAvatarSlot, string> = { default: "默认", thinking: "思考中", muted: "淡彩", offline: "离线" };

export function createProfileTools(deps: {
  db: Db; currentTurnId?: () => string | null; turnOrigin?: () => LeadTurnOrigin; now?: () => Date;
  // 配置文件里的 channels.slack.assistantEmoji（daemon 给，没配时 undefined）：结果里的 Slack 署名 emoji 按生效值写。
  configSlackEmoji?: () => string | undefined;
}): ToolDefinition<any>[] {
  const publish = (resource: string) => {
    publishGatewayEvents(deps.db, [{ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource } }]);
  };
  return [
    defineTool({
      name: "set_lead_avatar",
      label: "Set Lead Avatar",
      description:
        "改你的形象（界面上代表你的图）或 Slack 署名里你名字前面的 emoji。和设置 → 身份与风格 → 形象是同一个设置。"
        + "只有用户在这一轮明确要求时才能改：例如用户发来一张图说「用这张当你的头像」「思考的时候用这张动图」，或者「Slack 署名换成 :sparkles:」。"
        + "形象有四种状态：default（默认）、thinking（思考中）、muted（淡彩，答完的消息）、offline（离线）。"
        + "没上传的状态用上传的默认图；默认图也没上传时用系统自带的素材。"
        + "换图：slot 加 chat_image_id。chat_image_id 是用户在对话里发的图的编号：用户消息的 image_ids 属性里按顺序列着。"
        + "只收 PNG、GIF、WebP，最大 2 MB；JPEG 不收（没有透明），请用户换一张。去掉一种状态的图：slot 加 clear=true。"
        + "Slack 署名的 emoji：slack_emoji 写短代码（:robot_face: 或 robot_face），空字符串表示不加；reset_slack_emoji=true 回到配置或缺省的值。"
        + "界面上的矢量 FairyEye（Fairy 的眼睛）你打不开也关不掉：只有用户自己在这个会话里发 /fairyeye on 或 /fairyeye off。"
        + "用户问起时照这样告诉他。",
      parameters: Type.Object({
        slot: Type.Optional(Type.Union(LEAD_AVATAR_SLOTS.map((slot) => Type.Literal(slot)), {
          description: "要改哪种状态的图：default、thinking、muted、offline",
        })),
        chat_image_id: Type.Optional(Type.String({
          minLength: 1, maxLength: 80, description: "用户在对话里发的图的编号（img_ 开头，用户消息的 image_ids 里有）",
        })),
        clear: Type.Optional(Type.Boolean({ description: "true：去掉这种状态上传的图" })),
        slack_emoji: Type.Optional(Type.String({
          maxLength: SLACK_BYLINE_EMOJI_MAX_LENGTH + 8, description: "Slack 署名里你名字前面的 emoji 短代码，空字符串表示不加",
        })),
        reset_slack_emoji: Type.Optional(Type.Boolean({ description: "true：去掉设置的 emoji，回到配置或缺省的值" })),
      }),
      execute: async (_id, params: AvatarParams) => {
        const common = () => ({
          caller: { kind: "lead" as const, turnId: authorityTurnId(deps), external: turnOriginOf(deps).external },
          configSlackEmoji: deps.configSlackEmoji?.(),
          ...(deps.now ? { now: deps.now() } : {}),
          publish,
        });
        const done: string[] = [];
        let last: LeadAvatarOutcome | null = null;
        try {
          const wantsImage = params.chat_image_id !== undefined || params.clear !== undefined;
          const wantsEmoji = params.slack_emoji !== undefined || params.reset_slack_emoji === true;
          if (!params.slot && !wantsEmoji) throw new LeadAvatarError("invalid_input", "没有要改的内容：给 slot 加 chat_image_id 或 clear，或者给 slack_emoji");
          if (params.slot && !wantsImage) throw new LeadAvatarError("invalid_input", "给了 slot：还要给 chat_image_id（换图）或 clear=true（去掉图）");
          if (!params.slot && wantsImage) throw new LeadAvatarError("invalid_input", "换图或去掉图要给 slot");
          if (params.chat_image_id !== undefined && params.clear === true) {
            throw new LeadAvatarError("invalid_input", "chat_image_id 和 clear 只能给一个");
          }
          if (params.slot) {
            if (params.chat_image_id !== undefined) {
              const id = params.chat_image_id.trim();
              const image = CHAT_IMAGE_ID_PATTERN.test(id) ? getChatImage(deps.db, id) : null;
              if (!image) throw new LeadAvatarError("invalid_input", `没有编号是 ${id.slice(0, 80)} 的图：用用户消息的 image_ids 里的编号`);
              last = setLeadAvatarSlot(deps.db, { ...common(), slot: params.slot, data: image.data, mimeType: image.mimeType });
              if (last.changed) done.push(`${SLOT_LABELS[params.slot]}状态换成了这张图`);
            } else if (params.clear === true) {
              last = clearLeadAvatarSlot(deps.db, { ...common(), slot: params.slot });
              if (last.changed) done.push(`去掉了${SLOT_LABELS[params.slot]}状态的图`);
            } else {
              throw new LeadAvatarError("invalid_input", "clear 只能是 true");
            }
          }
          if (wantsEmoji) {
            last = setLeadAvatarSlackEmoji(deps.db, {
              ...common(), emoji: params.slack_emoji ?? null, ...(params.reset_slack_emoji === true ? { reset: true } : {}),
            });
            if (last.changed) done.push(params.reset_slack_emoji === true ? "Slack 署名的 emoji 回到了缺省" : "改了 Slack 署名的 emoji");
          }
        } catch (error) {
          if (error instanceof LeadAvatarError) {
            throw new Error(`没有改${done.length ? `完（已经${done.join("，")}）` : ""}：${error.message}`);
          }
          throw error;
        }
        const avatar = last!.avatar;
        const summary = {
          slots: Object.fromEntries(LEAD_AVATAR_SLOTS.map((slot) => [slot, avatar.slots[slot] ? avatar.slots[slot]!.mimeType : null])),
          slackEmoji: avatar.slackEmoji, slackEmojiSource: avatar.slackEmojiSource,
        };
        if (!done.length) return json({ result: "unchanged", avatar: summary });
        return json({
          result: "updated", changes: done, avatar: summary,
          next: "已经保存，界面和下一条 Slack 消息马上用新的。用一句话告诉用户改了什么；用户可以在设置 → 身份与风格 → 形象里再改。",
        });
      },
    }),

    defineTool({
      name: "update_lead_profile",
      label: "Update Lead Profile",
      description:
        "改你的名字、人格或者你和用户的互动风格，只给要改的字段。和设置 → 身份与风格是同一个设置。"
        + "只有用户在这一轮明确要求时才能改：例如「以后叫你 Jarvis」「说话别那么正式」「回复短一点」「别每次都问我」。"
        + "从对话里推测出来的偏好不算要求：先问用户要不要记成互动风格，用户答应了再改。"
        + "persona 和 interaction_style 是整段替换：先读系统提示 identity 一节里现在的内容，在它的基础上改，不要丢掉用户原来写的。"
        + "写的时候用用户的口吻，简短具体，例如「回复先给结论，最多三句；不用寒暄」。给空字符串表示清空。"
        + "改完以后系统记一次主人操作，用户能撤销；新的名字和风格从下一轮起生效。",
      parameters: Type.Object({
        name: Type.Optional(Type.String({ minLength: 1, maxLength: LEAD_NAME_MAX_LENGTH * 4, description: `新名字，最多 ${LEAD_NAME_MAX_LENGTH} 个字` })),
        persona: Type.Optional(Type.String({
          maxLength: LEAD_PROFILE_TEXT_MAX_LENGTH * 2,
          description: `你的人格：性格、腔调、说话习惯。最多 ${LEAD_PROFILE_TEXT_MAX_LENGTH} 个字`,
        })),
        interaction_style: Type.Optional(Type.String({
          maxLength: LEAD_PROFILE_TEXT_MAX_LENGTH * 2,
          description: `用户希望你怎样和他互动：长短、主动程度、称呼、什么时候打扰。最多 ${LEAD_PROFILE_TEXT_MAX_LENGTH} 个字`,
        })),
      }),
      execute: async (_id, params: ProfileParams) => {
        const request: LeadProfileRequest = {
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.persona !== undefined ? { persona: params.persona } : {}),
          ...(params.interaction_style !== undefined ? { interactionStyle: params.interaction_style } : {}),
        };
        let outcome;
        try {
          outcome = updateLeadProfile(deps.db, {
            request,
            caller: { kind: "lead", turnId: authorityTurnId(deps), external: turnOriginOf(deps).external },
            ...(deps.now ? { now: deps.now() } : {}),
            publish: (resource) => {
              publishGatewayEvents(deps.db, [{ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource } }]);
            },
          });
        } catch (error) {
          if (error instanceof LeadProfileError) throw new Error(`没有改：${error.message}`);
          throw error;
        }
        if (!outcome.changed) return json({ result: "unchanged", profile: outcome.profile });
        return json({
          result: "updated",
          profile: outcome.profile,
          next: "已经保存，从下一轮起按新的设置。用一句话告诉用户改了什么；用户可以在通知里撤销，或者在设置 → 身份与风格里再改。",
        });
      },
    }),
  ];
}
