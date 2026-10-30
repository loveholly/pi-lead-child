// find_skill：找用户给 agent 装的 skill（2026-10-28，文档「按需加载方案」，用户定的）。
// 用户装的 skill（~/.agents/skills 这类，现在 55 个）不再列进系统提示词：session.ts 加载时把它们标成不让模型自己调用，
// pi 就不把它们写进提示词的 skills 一节。Lead 要用时用这个工具找，找到以后照常用 read 读 SKILL.md。
//   - 不带 query：返回一份短目录，每个 skill 一行（名字和描述的第一句）。只在调用时出现。
//   - 带 query：用 SmartModel（Jev 打头）在全部 skill 里挑最相关的几个。一次调用一个选择题，写一条 decision_model.called。
//     没有 SmartModel、或者它失败时，退回短目录，结果里写明没有排序。
// Lead 自带的 skill 照常列在系统提示词里，这里不列。
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SmartModel } from "@pi-lead-child/engine";

export interface UserSkillInfo {
  name: string;
  description: string;
  filePath: string;
}

export interface SkillToolDeps {
  /** 用户装的 skill（不含 Lead 自带的）。缺省时（测试）没有。 */
  userSkills?: () => UserSkillInfo[];
  smartModel?: SmartModel | null;
}

const NONE = "（都不合适）";
const DESCRIPTION_MAX = 300;
const DEFAULT_LIMIT = 3;
/** 低于这个概率的不算匹配。选择题的概率分在所有选项上，几十个选项时单个选项的概率本来就低，所以门槛也低。 */
const MATCH_FLOOR = 0.08;

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: {} };
}

function firstSentence(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const end = flat.search(/[。.!?！？]\s|[。！？]/u);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length > 160 ? `${sentence.slice(0, 160)}…` : sentence;
}

function catalog(skills: UserSkillInfo[], note: string): string {
  const lines = skills
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => `- ${skill.name}：${firstSentence(skill.description)}（${skill.filePath}）`);
  return [note, ...lines].join("\n");
}

export function createSkillTools(deps: SkillToolDeps): ToolDefinition<any>[] {
  return [
    defineTool({
      name: "find_skill",
      label: "Find Skill",
      description:
        "找用户给 agent 装的 skill（~/.agents/skills、~/.claude/skills 这类）。它们不列在系统提示词里，你自带的 skill 照常列着。"
        + "query 写这次要做的事（中文、英文都行），返回最相关的几个 skill 的名字、说明和 SKILL.md 的路径；不给 query 时返回全部的短目录。"
        + "找到以后用 read 读 SKILL.md 全文再照做；里面写的 Claude Code 专用工具（Skill、Agent、mcp__ 开头的）换成你有的工具。",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "这次要做的事" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: `最多返回几个，缺省 ${DEFAULT_LIMIT}` })),
      }),
      execute: async (_id, params: { query?: string; limit?: number }, signal) => {
        const skills = deps.userSkills?.() ?? [];
        if (skills.length === 0) return text("没有用户装的 skill。");
        const query = params.query?.trim();
        if (!query) return text(catalog(skills, `用户装了 ${skills.length} 个 skill：`));
        const smart = deps.smartModel;
        if (!smart) return text(catalog(skills, `没有决策模型，不能排序。下面是全部 ${skills.length} 个 skill，按名字排：`));
        const descriptions: Record<string, string> = {};
        for (const skill of skills) descriptions[skill.name] = skill.description.replace(/\s+/g, " ").slice(0, DESCRIPTION_MAX);
        descriptions[NONE] = "没有一个 skill 讲的是这件事";
        try {
          const decision = await smart.decide(
            JSON.stringify({ task: query }),
            {
              skill: {
                type: "choice",
                prompt: "task 要做的事，哪一个 skill 讲的正是这类事的做法？只看 skill 的说明是否覆盖 task 要做的活动；话题沾边不算。",
                options: [...skills.map((skill) => skill.name), NONE],
                descriptions,
              },
            },
            { purpose: "find_skill", ...(signal ? { signal } : {}) },
          );
          const limit = params.limit ?? DEFAULT_LIMIT;
          const ranked = Object.entries(decision.answers.skill.probabilities)
            .filter(([name, probability]) => name !== NONE && probability >= MATCH_FLOOR)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit);
          if (ranked.length === 0) {
            return text(`没有找到讲「${query}」这件事的 skill。要看全部，不带 query 再调一次。`);
          }
          const byName = new Map(skills.map((skill) => [skill.name, skill]));
          const lines = ranked.map(([name, probability]) => {
            const skill = byName.get(name)!;
            return `- ${name}（匹配度 ${probability.toFixed(2)}）：${firstSentence(skill.description)}\n  ${skill.filePath}`;
          });
          return text([`和「${query}」最相关的 skill（${decision.backend} 排序）：`, ...lines].join("\n"));
        } catch (error) {
          return text(catalog(skills, `排序失败（${(error as Error).message}）。下面是全部 ${skills.length} 个 skill，按名字排：`));
        }
      },
    }),
  ];
}
