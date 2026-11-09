// 发给模型的文字里不写用户目录的完整路径（用户 2026-10-30：「包括还 hardcode 了我的用户目录」）。
// 完整路径里有用户的账号名，而系统提示词、工具说明和工具结果每一轮都发给模型服务商。
// Lead 的系统提示词（lead 的 home-paths.ts）、bash 工具说明和执行器目录（engine 的 runtime-catalog.ts）都用这一个函数。

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把文字里用户目录开头的路径写成 ~/…。只换整段的目录名：home 是 /Users/a 时，/Users/ab 不换。 */
export function tildeHome(text: string, home: string): string {
  const root = home.replace(/\/+$/, "");
  if (root === "") return text;
  return text.replace(new RegExp(`${escapeRegExp(root)}(?=/|$|[^\\w.@-])`, "g"), "~");
}
