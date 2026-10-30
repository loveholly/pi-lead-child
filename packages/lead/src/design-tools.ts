// Lead 改界面的外观：update_design_preferences（2026-10-22）。
// 和设置页「外观」调同一个函数（engine 的 updateDesignPreferences）：同样的校验，同样的主人操作。
// 权限是 user_only：只有用户在这一轮明确要求时才能改。现在的值不用工具读：系统提示的 appearance 一节每一轮都写着。
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  DENSITY_LEVELS, DESIGN_NOTES_MAX_LENGTH, LINE_HEIGHT_LEVELS, RADIUS_LEVELS, TEXT_SCALE_LEVELS,
  type DesignPreferencesRequest,
} from "@pi-lead-child/protocol";
import { DesignPreferencesError, updateDesignPreferences } from "@pi-lead-child/engine";
import { publishGatewayEvents, type Db } from "@pi-lead-child/store";
import { authorityTurnId, turnOriginOf, type LeadTurnOrigin } from "./turn-origin.js";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: {} };
}

const Literals = <T extends readonly string[]>(values: T, description: string) =>
  Type.Optional(Type.Union(values.map((value) => Type.Literal(value)), { description }));
const Hex = (description: string) => Type.Optional(Type.String({ pattern: "^#[0-9a-fA-F]{6}$", description }));

export function createDesignTools(deps: { db: Db; currentTurnId?: () => string | null; turnOrigin?: () => LeadTurnOrigin; now?: () => Date }): ToolDefinition<any>[] {
  return [
    defineTool({
      name: "update_design_preferences",
      label: "Update Design Preferences",
      description:
        "改界面的外观，只给要改的字段。和设置 → 外观是同一个设置。"
        + "只有用户在这一轮明确要求时才能改：例如「卡片太挤了，松一点」「圆角大一点」「字再大一号」「主色换成绿色」。"
        + "用户只是评价一张卡片好看不好看时，不要直接改全局：先问他是想改整个界面，还是只是这一次。"
        + "密度按区域改（workspace 工作台的面板、ticket 工单详情、conversation 会话、settings 设置），用户说「列表」「收件箱」指工作台，说「聊天」指会话。"
        + "颜色写 #RRGGBB；主色会当链接文字用，白底上要够深（对比度至少 4.5:1），不够时系统会拒绝并说明。"
        + "notes 是用户自己对外观的描述（喜欢什么、不喜欢什么），整段替换：先读 appearance 一节里现在的内容，在它的基础上改，用用户的口吻。"
        + "改完以后系统记一次主人操作，用户能撤销；网页立即生效。",
      parameters: Type.Object({
        density: Type.Optional(Type.Object({
          workspace: Literals(DENSITY_LEVELS, "工作台的面板：收件箱、工单列表、项目、日程"),
          ticket: Literals(DENSITY_LEVELS, "工单详情"),
          conversation: Literals(DENSITY_LEVELS, "会话"),
          settings: Literals(DENSITY_LEVELS, "设置和配对"),
        }, { additionalProperties: false })),
        radius: Literals(RADIUS_LEVELS, "圆角：sharp 小、soft 标准、round 大"),
        line_height: Literals(LINE_HEIGHT_LEVELS, "行高：tight 紧、normal 标准、loose 松"),
        text_scale: Literals(TEXT_SCALE_LEVELS, "字号基准：small 小一号、medium 标准、large 大一号"),
        colors: Type.Optional(Type.Object({
          accent: Hex("主色（强调色、链接、主要按钮）"),
          success: Hex("成功"),
          warning: Hex("警告"),
          danger: Hex("危险、错误"),
          info: Hex("信息"),
        }, { additionalProperties: false })),
        notes: Type.Optional(Type.String({ maxLength: DESIGN_NOTES_MAX_LENGTH * 2, description: `用户对外观的描述，最多 ${DESIGN_NOTES_MAX_LENGTH} 个字` })),
      }),
      execute: async (_id, params: {
        density?: DesignPreferencesRequest["density"]; radius?: DesignPreferencesRequest["radius"];
        line_height?: DesignPreferencesRequest["lineHeight"]; text_scale?: DesignPreferencesRequest["textScale"];
        colors?: DesignPreferencesRequest["colors"]; notes?: string;
      }) => {
        const request: DesignPreferencesRequest = {
          ...(params.density !== undefined ? { density: params.density } : {}),
          ...(params.radius !== undefined ? { radius: params.radius } : {}),
          ...(params.line_height !== undefined ? { lineHeight: params.line_height } : {}),
          ...(params.text_scale !== undefined ? { textScale: params.text_scale } : {}),
          ...(params.colors !== undefined ? { colors: params.colors } : {}),
          ...(params.notes !== undefined ? { notes: params.notes } : {}),
        };
        let outcome;
        try {
          outcome = updateDesignPreferences(deps.db, {
            request,
            caller: { kind: "lead", turnId: authorityTurnId(deps), external: turnOriginOf(deps).external },
            ...(deps.now ? { now: deps.now() } : {}),
            publish: (resource) => {
              publishGatewayEvents(deps.db, [{ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource } }]);
            },
          });
        } catch (error) {
          if (error instanceof DesignPreferencesError) throw new Error(`没有改：${error.message}`);
          throw error;
        }
        if (!outcome.changed) return json({ result: "unchanged", preferences: outcome.preferences });
        return json({
          result: "updated",
          preferences: outcome.preferences,
          next: "已经保存，网页立即生效。用一句话告诉用户改了什么；用户可以在通知里撤销，或者在设置 → 外观里再改。",
        });
      },
    }),
  ];
}
