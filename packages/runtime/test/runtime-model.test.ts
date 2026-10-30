import { describe, expect, it } from "vitest";
import { defaultRuntimeModel, resolveRuntimeModel } from "../src/model.js";

describe("resolveRuntimeModel", () => {
  // 2026-10-15：以前没有配置时用写死的 gpt-5.5，还把 gpt-5.6-sol 改写成 gpt-5.5。账号不再支持 gpt-5.5，
  // 工单 #66 的核查连续失败 7 次，而用户自己的 Codex 配置是 gpt-6.1-sol。现在没有配置就不传模型。
  it("passes no model to Codex or pi unless one is configured", () => {
    const saved = { codex: process.env.PLC_CODEX_MODEL, pi: process.env.PLC_PI_MODEL, child: process.env.PLC_CHILD_MODEL };
    delete process.env.PLC_CODEX_MODEL;
    delete process.env.PLC_PI_MODEL;
    delete process.env.PLC_CHILD_MODEL;
    try {
      expect(defaultRuntimeModel("codex")).toBeUndefined();
      expect(defaultRuntimeModel("pi")).toBeUndefined();
      expect(defaultRuntimeModel("claude")).toBeUndefined();
      process.env.PLC_CODEX_MODEL = "gpt-6.1-sol";
      expect(defaultRuntimeModel("codex")).toBe("gpt-6.1-sol");
    } finally {
      for (const [name, value] of [["PLC_CODEX_MODEL", saved.codex], ["PLC_PI_MODEL", saved.pi], ["PLC_CHILD_MODEL", saved.child]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("converts provider-qualified OpenAI models for Codex", () => {
    expect(resolveRuntimeModel("codex", "openai/gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(resolveRuntimeModel("codex", "gpt-6.1-sol")).toBe("gpt-6.1-sol");
  });

  it("passes Codex model ids through unchanged", () => {
    expect(resolveRuntimeModel("codex", "openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(resolveRuntimeModel("codex", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("keeps provider-qualified models for Pi", () => {
    expect(resolveRuntimeModel("pi", "openai/gpt-5.6-sol")).toBe("openai/gpt-5.6-sol");
  });

  it("rejects provider-mismatched Codex models", () => {
    expect(() => resolveRuntimeModel("codex", "anthropic/claude-opus"))
      .toThrow(/runtime 'codex' cannot use model/);
  });
});
