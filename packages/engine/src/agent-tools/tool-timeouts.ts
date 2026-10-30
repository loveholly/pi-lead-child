// Claude Code、Codex 经 MCP 调宿主工具时，mcp-server.ts 等宿主回复的时限。宿主这边的工具要在这之前返回，
// 否则 agent 先报超时，以为工具调用失败（工单 04 审查 M1：交付时等快照的上限曾经正好等于这个时限）。
// 放在单独的文件里：mcp-server.ts 是一个独立进程的入口，引用它会执行它的顶层代码。

/** 宿主工具的时限。 */
export const HOST_AGENT_TOOL_TIMEOUT_MS = 30_000;

/** 连接的工具要等外部服务，时限长一些。 */
export const CONNECTION_AGENT_TOOL_TIMEOUT_MS = 130_000;
