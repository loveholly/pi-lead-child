// 系统提示词里不写用户目录的完整路径（用户 2026-10-30：「包括还 hardcode 了我的用户目录」）。
//
// 系统提示词每一轮都发给模型服务商，完整路径里有用户的账号名。它从几处进来：pi 的工作目录一节（Lead 的数据目录）、
// skills 一节里每个 skill 文件的位置、「你运行的环境」里代码的位置，还有常驻偏好里用户自己写的路径。
// 用户目录下的路径一律写成 ~/…：Lead 的 read、grep、find、ls 认得 ~（pi 的 path-utils），bash 也认得。
// 只改发给模型的提示词，不改 skill 和文件本身。
import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { tildeHome } from "@pi-lead-child/core";

export { tildeHome };

/**
 * pi 在 before_agent_start 交给扩展的提示词选项：每一样会进系统提示词的文字里，用户目录都写成 ~。
 * 要在别的扩展改完之后调用（session.ts 把它注册成最后一个扩展）。
 */
export function hideHomeInPrompt(options: NormalizedBuildSystemPromptOptions, home: string): void {
  const tilde = (text: string) => tildeHome(text, home);
  rewritePromptText(options, tilde);
  // pi 的工作目录一节（cwd）：同名的自定义节盖掉 pi 自己写的那一节。
  if (options.cwd) options.sections.cwd = tilde(options.cwd.replace(/\\/g, "/"));
}

/**
 * Writes the versioned code root (runtime/versions/<version>) as its stable link (runtime/current) in every prompt text,
 * for example the location of Lead's own skills. A path that changes on each upgrade changes the system prompt, and the
 * provider can no longer serve the prompt from its cache. Does nothing when both are the same.
 */
export function stableCodePathsInPrompt(options: NormalizedBuildSystemPromptOptions, root: string, stable: string): void {
  if (!root || root === stable) return;
  rewritePromptText(options, (text) => text.split(root).join(stable));
}

// Applies one text rewrite to every prompt field that can hold a path.
function rewritePromptText(options: NormalizedBuildSystemPromptOptions, rewrite: (text: string) => string): void {
  if (options.customPrompt) options.customPrompt = rewrite(options.customPrompt);
  options.appendSystemPrompt = rewrite(options.appendSystemPrompt);
  options.promptGuidelines = options.promptGuidelines.map(rewrite);
  options.toolSnippets = Object.fromEntries(Object.entries(options.toolSnippets).map(([name, text]) => [name, rewrite(text)]));
  options.toolGuidelines = Object.fromEntries(
    Object.entries(options.toolGuidelines).map(([name, lines]) => [name, lines.map(rewrite)]),
  );
  for (const [name, content] of Object.entries(options.sections)) options.sections[name] = rewrite(content);
  options.contextFiles = options.contextFiles.map((file) => ({ path: rewrite(file.path), content: rewrite(file.content) }));
  options.skills = options.skills.map((skill) => ({ ...skill, filePath: rewrite(skill.filePath) }));
}
