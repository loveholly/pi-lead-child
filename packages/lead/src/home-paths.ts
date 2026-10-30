// 系统提示词里不写用户目录的完整路径（用户 2026-10-30：「包括还 hardcode 了我的用户目录」）。
//
// 系统提示词每一轮都发给模型服务商，完整路径里有用户的账号名。它从几处进来：pi 的工作目录一节（Lead 的数据目录）、
// skills 一节里每个 skill 文件的位置、「你运行的环境」里代码的位置，还有常驻偏好里用户自己写的路径。
// 用户目录下的路径一律写成 ~/…：Lead 的 read、grep、find、ls 认得 ~（pi 的 path-utils），bash 也认得。
// 只改发给模型的提示词，不改 skill 和文件本身。
import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把文字里用户目录开头的路径写成 ~/…。只换整段的目录名：home 是 /Users/a 时，/Users/ab 不换。 */
export function tildeHome(text: string, home: string): string {
  const root = home.replace(/\/+$/, "");
  if (root === "") return text;
  return text.replace(new RegExp(`${escapeRegExp(root)}(?=/|$|[^\\w.@-])`, "g"), "~");
}

/**
 * pi 在 before_agent_start 交给扩展的提示词选项：每一样会进系统提示词的文字里，用户目录都写成 ~。
 * 要在别的扩展改完之后调用（session.ts 把它注册成最后一个扩展）。
 */
export function hideHomeInPrompt(options: NormalizedBuildSystemPromptOptions, home: string): void {
  const tilde = (text: string) => tildeHome(text, home);
  if (options.customPrompt) options.customPrompt = tilde(options.customPrompt);
  options.appendSystemPrompt = tilde(options.appendSystemPrompt);
  options.promptGuidelines = options.promptGuidelines.map(tilde);
  options.toolSnippets = Object.fromEntries(Object.entries(options.toolSnippets).map(([name, text]) => [name, tilde(text)]));
  options.toolGuidelines = Object.fromEntries(
    Object.entries(options.toolGuidelines).map(([name, lines]) => [name, lines.map(tilde)]),
  );
  for (const [name, content] of Object.entries(options.sections)) options.sections[name] = tilde(content);
  // pi 的工作目录一节（cwd）：同名的自定义节盖掉 pi 自己写的那一节。
  if (options.cwd) options.sections.cwd = tilde(options.cwd.replace(/\\/g, "/"));
  options.contextFiles = options.contextFiles.map((file) => ({ path: tilde(file.path), content: tilde(file.content) }));
  options.skills = options.skills.map((skill) => ({ ...skill, filePath: tilde(skill.filePath) }));
}
