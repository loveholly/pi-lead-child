// 外部内容的不可信标签。代查的只读工具在 2026-10-22 随代查退役了（落地计划 D1）；子 agent（agent-task/）的提示词和工具结果
// 照样用它把外部原文包起来。
// 这里不出现任何具体来源的名字。

/** 外部内容放进不可信的标签里。内容里出现结束标签时打断它，模型不会以为标签结束了。 */
export function untrusted(source: string, body: string): string {
  const safeSource = source.replace(/["<>\n]/g, " ").slice(0, 300);
  const safeBody = body.replace(/<\/untrusted_external_text/gi, "<\\/untrusted_external_text");
  return `<untrusted_external_text source="${safeSource}">\n${safeBody}\n</untrusted_external_text>`;
}
