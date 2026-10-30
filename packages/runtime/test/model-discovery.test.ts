// 模型目录的发现（2026-10-15 用户决定：不写死模型）。输入是本机 2026-10-15 的真实输出，截短：
// codex-cli 0.162.1 的 `codex debug models`、Claude Code 2.1.258 的 `claude --help`、pi 1.1.0 的
// `pi --list-models` 和 `pi --help`。
import { describe, expect, it } from "vitest";

import {
  claudeModelsFromHelp,
  cliEffortValue,
  parseCodexConfigModel,
  parseCodexModelCatalog,
  parsePiModelList,
  parsePiSettingsDefault,
  parsePiThinkingLevels,
  piProviders,
} from "../src/model-discovery.js";

const CODEX_MODELS = JSON.stringify({
  models: [
    {
      slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 5,
      description: "Balanced model for everyday coding. Good default.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }],
    },
    {
      slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 43,
      default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }],
    },
    {
      slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list", priority: 0,
      description: "Latest frontier agentic coding model.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
    },
  ],
});

const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]

Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <environment_id>        Create a new cloud session that runs on
                                        the given self-hosted environment
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session
`;

const PI_LIST = `provider   model                     context  max-out  thinking  images
acme  gpt-4o-mini               128K     16.4K    no        no
openai     gpt-6.1-sol               400K     128K     yes       yes
`;

const PI_HELP = `Options:
  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh, max
  --list-models [search]         List available models (with optional fuzzy search)
`;

describe("model discovery", () => {
  it("reads the Codex account catalog in priority order and leaves out hidden models", () => {
    expect(parseCodexModelCatalog(CODEX_MODELS)).toEqual([
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["low", "medium", "high"], defaultEffort: "medium", note: "Latest frontier agentic coding model." },
      {
        id: "gpt-5.6-sol", label: "GPT-5.6-Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultEffort: "medium", note: "Balanced model for everyday coding.",
      },
    ]);
  });

  it("reads only the top-level model line of the Codex config", () => {
    expect(parseCodexConfigModel('model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n')).toBe("gpt-6.1-sol");
    expect(parseCodexConfigModel('[profiles.fast]\nmodel = "gpt-6-luna"\n')).toBeNull();
  });

  it("takes the Claude Code aliases and effort levels from its help", () => {
    const { models, efforts } = claudeModelsFromHelp(CLAUDE_HELP);
    expect(efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(models.map((model) => model.id)).toEqual(["fable", "opus", "sonnet"]);
    expect(models[1]).toMatchObject({ efforts: ["low", "medium", "high", "xhigh", "max"], note: expect.stringContaining("最新") });
  });

  it("lists pi models as provider/model and gives thinking levels only to models that think", () => {
    const levels = parsePiThinkingLevels(PI_HELP);
    expect(levels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(parsePiModelList(PI_LIST, levels)).toEqual([
      { id: "acme/gpt-4o-mini", label: "acme/gpt-4o-mini", efforts: [], defaultEffort: null, note: "不支持 thinking" },
      { id: "openai/gpt-6.1-sol", label: "openai/gpt-6.1-sol", efforts: levels, defaultEffort: null, note: null },
    ]);
  });

  // pi 自己的默认模型写在 <agent-dir>/settings.json（2026-10-15 用户把它设成 vibeproxy 的 Sonnet 5.5）。
  // 目录记下它，Lead 才知道不传模型时 pi 会用哪一个；目录也写出 pi 用的是哪些 provider。
  it("reads pi's own default model and names its providers", () => {
    expect(parsePiSettingsDefault(JSON.stringify({ defaultProvider: "vibeproxy", defaultModel: "claude-sonnet-5-5" })))
      .toBe("vibeproxy/claude-sonnet-5-5");
    expect(parsePiSettingsDefault(JSON.stringify({ defaultModel: "claude-sonnet-5-5" }))).toBeNull();
    expect(parsePiSettingsDefault("not json")).toBeNull();
    const levels = parsePiThinkingLevels(PI_HELP);
    expect(piProviders(parsePiModelList(PI_LIST, levels))).toEqual(["acme", "openai"]);
  });

  it("refuses an effort value that looks like an option", () => {
    expect(cliEffortValue(" high ")).toBe("high");
    expect(cliEffortValue(undefined)).toBeUndefined();
    expect(() => cliEffortValue("--dangerously-skip-permissions")).toThrow(/invalid effort/);
  });
});
