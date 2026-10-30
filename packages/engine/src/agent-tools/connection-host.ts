// child 用连接的通道。连接（packages/connections 的 ConnectionHub）只在 daemon 进程里：令牌在那里解密，
// 不进 child 的进程。daemon 启动时登记一个 host，工具桥（host-bridge.ts）在 daemon 进程里调它。
// child 自己的进程里没有 host：直接打开账本的模式下，这两个工具回答「要经过 daemon」。
//
// engine 不依赖 connections 包，只认这个接口（依赖方向见 apps/daemon/test/package-boundaries.test.ts）。
export type AgentConnectionRole = "executor" | "reviewer";

// 调用来自哪个 Run。Run 带权限清单时（store 的 run_grants），连接中心按清单检查每一次调用（landing.md 第 5 节）。
export interface AgentConnectionContext {
  runId: number;
}

export interface AgentConnectionHost {
  // 返回给 child 的结果是普通的 JSON。预期内的失败（没连接、不允许、清单不允许）也以结果返回，不抛错。
  search(role: AgentConnectionRole, input: { connection?: string; query?: string; limit?: number }, context?: AgentConnectionContext): Promise<unknown>;
  call(
    role: AgentConnectionRole, input: { connection: string; tool: string; arguments: Record<string, unknown> }, signal?: AbortSignal,
    context?: AgentConnectionContext,
  ): Promise<unknown>;
}

let host: AgentConnectionHost | null = null;

export function setAgentConnectionHost(next: AgentConnectionHost | null): void {
  host = next;
}

export function agentConnectionHost(): AgentConnectionHost | null {
  return host;
}

export const AGENT_CONNECTION_TOOLS = ["search_connection_tools", "call_connection_tool"] as const;

// pi 的 child 只把这些工具经工具桥交给 daemon 做（extension/ticket-tools.ts），别的在 child 进程里直接写库。
// git_fetch 要用户的 git 凭证，只有 daemon 有（2026-10-29）。
export const AGENT_BRIDGE_TOOLS: readonly string[] = [...AGENT_CONNECTION_TOOLS, "git_fetch"];
