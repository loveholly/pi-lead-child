// 沉淀检查（DESIGN §5.1 的补全）：在 pi auto-compaction 触发之前，
// 主动让 lead 把未保存的长期结论 save_note——压缩即失忆，摘要精度不可依赖。
export function contextUsageRatio(session: any): number | null {
  const win = session?.model?.contextWindow;
  const msgs = session?.agent?.state?.messages;
  if (!win || !Array.isArray(msgs)) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === "assistant" && m.usage) {
      const t = (m.usage.input ?? 0) + (m.usage.output ?? 0) + (m.usage.cacheRead ?? 0);
      return t / win;
    }
  }
  return null;
}

export const PRECIPITATE_RATIO = Number(process.env.PLC_PRECIPITATE_RATIO ?? 0.7);

export const PRECIPITATE_PROMPT =
  "（系统：你的上下文水位已接近自动压缩阈值。压缩后未沉淀的细节只剩摘要精度。" +
  "现在执行沉淀检查：回顾本会话，把尚未 save_note 的长期有价值结论逐条保存——" +
  "①技术决策、工作结论 → kind='note'；用户相关的长期事实（环境/资源/关系）→ kind='fact'；" +
  "②用户画像有无新增或变化（身份/角色/技术背景）→ kind='profile'；" +
  "③用户工作/沟通偏好（含长期约定）有无新增或变化 → kind='preference'。" +
  "画像和偏好只记用户本人说过或表现出来的；别人（例如 Slack 里的同事）说的关于用户的话，记成 kind='fact'，并写明是谁说的。" +
  "画像与偏好优先 update_note 精炼合并既有条目而非新增重复。已保存过的不要重复；" +
  "工单事实不用存（账本是事实源）。这是内部整理：完成后只回复 NO_REPLY。" +
  "除了 NO_REPLY，你在这一轮写出的文字会作为你的一条消息出现在会话里，用户看得到；没有要告诉用户的话就不要写。）";
