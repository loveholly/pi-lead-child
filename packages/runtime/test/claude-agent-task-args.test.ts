// 通道派的代查在 Claude Code 里的启动参数（工单 #464）：只读形态，不给自带工具，不加载用户的设置，只连一个工具通道。
// 直接看拼出来的参数，不启动 CLI。
import { describe, expect, it } from "vitest";
import { ClaudeRuntime } from "../src/claude.js";
import type { RuntimeStartRequest } from "../src/types.js";

const request = (overrides: Partial<RuntimeStartRequest> = {}): RuntimeStartRequest => ({
  itemId: 1, runId: 2, role: "executor", purpose: "lookup", prompt: "question", workdir: process.cwd(), env: {},
  agentTask: { systemPrompt: "you are a read-only sub agent" }, model: "sonnet", effort: "medium", ...overrides,
});

const argsOf = (input: RuntimeStartRequest, mcpConfig: string | null = "/tmp/plc-mcp-x/mcp-config.json"): string[] =>
  (new ClaudeRuntime() as unknown as { buildArgs(r: RuntimeStartRequest, mcp: string | null): string[] }).buildArgs(input, mcpConfig);

describe("Claude Code arguments for an agent task", () => {
  it("has no built-in tools, ignores user settings, and connects only the one tool channel", () => {
    const args = argsOf(request());
    expect(args).toContain("--restricted");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/tmp/plc-mcp-x/mcp-config.json");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__plc__*");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("you are a read-only sub agent");
  });

  it("passes the model and effort, and puts the prompt last", () => {
    const args = argsOf(request());
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 4)).toEqual(["--model", "sonnet", "--effort", "medium"]);
    expect(args.at(-1)).toBe("question");
  });

  it("drops the executor's sandbox, skills and command allowlist", () => {
    const args = argsOf(request());
    for (const flag of ["--settings", "--plugin-dir", "--resume", "--bare", "--safe-mode"]) expect(args).not.toContain(flag);
    expect(args.join(" ")).not.toMatch(/Bash\(/);
  });

  it("refuses to start without its tool channel", () => {
    expect(() => argsOf(request(), null)).toThrow(/tool channel/);
  });

  it("leaves the normal executor arguments alone when the request is not an agent task", () => {
    const args = argsOf(request({ agentTask: undefined, purpose: "execution" }));
    expect(args).not.toContain("--restricted");
    expect(args).toContain("--settings");
  });
});
