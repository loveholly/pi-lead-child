import type { KernelRuntimeId } from '@pi-lead-child/protocol';

// 执行 agent 的显示名，和服务端 adapter 的 displayName 一致（packages/runtime 的 pi.ts、claude.ts、codex.ts）。
// 应用不依赖 packages/runtime，所以这里抄一份。放在 workspace 里：工单详情和进展记录都用它。
const RUNTIME_NAMES: Record<KernelRuntimeId, string> = {
  pi: 'Pi agent',
  codex: 'Codex',
  claude: 'Claude Code',
};

/** 「claude」→「Claude Code」。不认识的 id 原样返回。 */
export function runtimeDisplayName(runtime: string | null | undefined): string | null {
  if (!runtime) return null;
  return (RUNTIME_NAMES as Record<string, string>)[runtime] ?? runtime;
}
