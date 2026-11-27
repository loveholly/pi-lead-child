// 通道派的代查选 runtime（工单 #464，#501 按评审改回 pi 优先）：缺省仍是 pi，用户停用的跳过，都停用了就明确失败。
// 起因：停用 pi 以后，代查单仍然跑在 pi 上（模型走 Lead 的便宜模型配置），6 秒后因账号被停用返回 403。
import { describe, expect, it } from "vitest";
import {
  AGENT_TASK_CLAUDE_DEFAULTS, AGENT_TASK_RUNTIMES, AgentTaskRuntimeUnavailableError, pickAgentTaskRuntime,
} from "../src/registry.js";

describe("picking the runtime of an agent task", () => {
  it("keeps pi as the default when nothing is disabled; pi picks its own model", () => {
    expect(pickAgentTaskRuntime({}, {})).toEqual({ runtime: "pi", model: null, effort: null });
    expect(AGENT_TASK_RUNTIMES[0]).toBe("pi");
  });

  it("still uses pi when only Codex is disabled", () => {
    expect(pickAgentTaskRuntime({}, { PLC_DISABLED_RUNTIMES: "codex" }).runtime).toBe("pi");
  });

  it("never picks pi while the user has disabled it", () => {
    for (const disabled of ["pi", "pi,codex", "codex,pi"]) {
      expect(pickAgentTaskRuntime({}, { PLC_DISABLED_RUNTIMES: disabled }).runtime).toBe("claude");
    }
  });

  it("uses sonnet and medium effort on Claude Code when pi is disabled and nothing is specified", () => {
    expect(pickAgentTaskRuntime({}, { PLC_DISABLED_RUNTIMES: "pi" })).toEqual({ runtime: "claude", model: "sonnet", effort: "medium" });
    expect(AGENT_TASK_CLAUDE_DEFAULTS).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("keeps an explicitly given model and effort on Claude Code", () => {
    const env = { PLC_DISABLED_RUNTIMES: "pi" };
    expect(pickAgentTaskRuntime({ model: "opus" }, env)).toEqual({ runtime: "claude", model: "opus", effort: "medium" });
    expect(pickAgentTaskRuntime({ effort: "high" }, env)).toEqual({ runtime: "claude", model: "sonnet", effort: "high" });
  });

  it("does not move to Claude Code just because it is disabled and pi is not", () => {
    expect(pickAgentTaskRuntime({ model: "opus" }, { PLC_DISABLED_RUNTIMES: "claude" })).toEqual({ runtime: "pi", model: null, effort: null });
  });

  it("fails with a clear error when no runtime is left, and names each disabled one", () => {
    const env = { PLC_DISABLED_RUNTIMES: "claude,pi" };
    expect(() => pickAgentTaskRuntime({}, env)).toThrow(AgentTaskRuntimeUnavailableError);
    expect(() => pickAgentTaskRuntime({}, env)).toThrow(/没有可用的 runtime 能跑代查.*Pi agent.*Claude Code/s);
  });

  it("does not offer Codex: its exec always carries a shell tool", () => {
    expect(AGENT_TASK_RUNTIMES).not.toContain("codex");
    expect(() => pickAgentTaskRuntime({}, { PLC_DISABLED_RUNTIMES: "claude,pi" })).toThrow(AgentTaskRuntimeUnavailableError);
  });
});
