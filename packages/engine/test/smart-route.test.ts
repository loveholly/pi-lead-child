// 选型建议：硬规则先筛候选，再由 SmartModel 在候选里判断。SmartModel 用假的，记下它被问了什么。
import { describe, expect, it } from "vitest";
import type { RuntimeId } from "@pi-lead-child/core";
import type { RuntimeCapabilities } from "@pi-lead-child/runtime";
import {
  mapEffortLevel,
  routeCandidates,
  suggestRoute,
  type ModelCatalog,
  type RuntimeCatalog,
  type SmartAnswer,
  type SmartModel,
  type SmartQuestionSet,
} from "../src/index.js";

const caps = (review: boolean): RuntimeCapabilities => ({
  streaming: true, steering: false, resume: true, interrupt: true, approvals: false, mcp: true, executableReadOnlyReview: review,
});

function runtimes(available: Partial<Record<RuntimeId, boolean>> = { codex: true, claude: true, pi: true }): RuntimeCatalog {
  const entry = (id: RuntimeId, review: boolean, models: string[]) => ({
    id, available: available[id] ?? false, executable: available[id] ? `/bin/${id}` : null,
    defaultModel: models[0] ?? null, models, capabilities: caps(review), reason: available[id] ? null : "executable not found",
  });
  return {
    entries: [
      entry("codex", true, ["gpt-5.5"]),
      entry("claude", false, []),
      entry("pi", false, ["vibeproxy/gemini-3.7-flash"]),
    ],
  };
}

const MODELS: ModelCatalog = {
  refreshedAt: "2026-10-16T00:00:00.000Z",
  runtimes: [
    {
      runtime: "codex", state: "known", source: "codex debug models", account: null, freeformModelPattern: null,
      refreshedAt: null, error: null, cliDefaultModel: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"],
      models: [
        { id: "gpt-5.5", label: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", note: null },
        { id: "gpt-5.4-mini", label: "gpt-5.4-mini", efforts: ["low", "medium", "high"], defaultEffort: "medium", note: "fast" },
      ],
    },
    {
      runtime: "claude", state: "known", source: "claude --help", account: null, freeformModelPattern: null,
      refreshedAt: null, error: null, cliDefaultModel: null, efforts: ["low", "medium", "high", "xhigh", "max"],
      models: [
        { id: "opus", label: "opus", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null, note: "alias" },
        { id: "haiku", label: "haiku", efforts: [], defaultEffort: null, note: "alias" },
      ],
    },
    {
      runtime: "pi", state: "unknown", source: "not discovered", account: null, freeformModelPattern: null,
      refreshedAt: null, error: "not discovered yet", cliDefaultModel: null, efforts: [], models: [],
    },
  ],
};

interface FakeCall { state: string; questions: SmartQuestionSet; purpose: string | undefined }

// 假的 SmartModel：route 选 pick，effort 选 level，其余固定。backend 是回答的后端名。
function fakeSmart(
  pick: string,
  level: number,
  route: Record<string, number> = {},
  backend = "fake",
): SmartModel & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  return {
    backend,
    calls,
    async decide(state, questions, opts) {
      calls.push({ state, questions, purpose: opts?.purpose });
      const answers: Record<string, SmartAnswer> = {};
      for (const [name, question] of Object.entries(questions)) {
        if (question.type === "choice" && name === "route") {
          const probabilities = Object.fromEntries(question.options.map((option) => [option, route[option] ?? 0]));
          answers[name] = { type: "choice", choice: pick, confidence: 0.5, probabilities };
        } else if (question.type === "choice") {
          answers[name] = {
            type: "choice", choice: "coding", confidence: 0.8,
            probabilities: Object.fromEntries(question.options.map((option) => [option, option === "coding" ? 1 : 0])),
          };
        } else if (question.type === "score") {
          answers[name] = {
            type: "score", level, label: question.levels[level]!, score: level, confidence: 0.7,
            probabilities: question.levels.map((_, index) => (index === level ? 1 : 0)),
          };
        } else {
          answers[name] = { type: "yes_no", probability: 0.83 };
        }
      }
      return { answers: answers as never, backend, model: "fake-1", latencyMs: 3, fallbackFrom: null };
    },
  };
}

describe("routeCandidates (hard rules)", () => {
  it("drops runtimes whose executable is missing", () => {
    const { candidates, excluded } = routeCandidates({ role: "executor", catalog: runtimes({ codex: true }), modelCatalog: MODELS });
    expect(candidates.map((candidate) => candidate.runtime)).toEqual(["codex"]);
    expect(excluded).toEqual([
      { runtime: "claude", reason: "executable not found" },
      { runtime: "pi", reason: "executable not found" },
    ]);
  });

  // 2026-10-20：任何 runtime 都能当核查员。能做可执行只读核查的排在前面，其余照目录的顺序。
  it("offers every runtime to a reviewer, the ones that can run commands first", () => {
    const { candidates, excluded } = routeCandidates({ role: "reviewer", catalog: runtimes(), modelCatalog: MODELS });
    expect(candidates.map((candidate) => candidate.runtime)).toEqual(["codex", "claude", "pi"]);
    expect(excluded).toEqual([]);
    const reversed: RuntimeCatalog = { entries: [...runtimes().entries].reverse() };
    expect(routeCandidates({ role: "reviewer", catalog: reversed, modelCatalog: MODELS }).candidates
      .map((candidate) => candidate.runtime)).toEqual(["codex", "pi", "claude"]);
    expect(routeCandidates({ role: "executor", catalog: reversed, modelCatalog: MODELS }).candidates
      .map((candidate) => candidate.runtime)).toEqual(["pi", "claude", "codex"]);
  });

  it("drops runtimes and models the health ledger marks unavailable", () => {
    const { candidates, excluded } = routeCandidates({
      role: "executor", catalog: runtimes(), modelCatalog: MODELS,
      runtimeUnavailable: (runtime) => runtime === "pi",
      modelUnavailable: (runtime, model) => runtime === "codex" && model === "gpt-5.5",
    });
    expect(candidates).toEqual([
      { runtime: "codex", models: ["gpt-5.4-mini"] },
      { runtime: "claude", models: ["opus", "haiku"] },
    ]);
    // 被排除的模型也列出来（2026-10-19）：以前它们悄悄消失，Lead 看不出为什么没有推荐它。
    expect(excluded).toEqual([
      { runtime: "codex", model: "gpt-5.5", reason: "unavailable in the runtime health ledger" },
      { runtime: "pi", reason: "unavailable in the runtime health ledger" },
    ]);
  });

  it("uses the configured models when the model catalog is unknown", () => {
    const { candidates } = routeCandidates({ role: "executor", catalog: runtimes({ pi: true }), modelCatalog: MODELS });
    expect(candidates).toEqual([{ runtime: "pi", models: ["vibeproxy/gemini-3.7-flash"] }]);
  });
});

describe("mapEffortLevel", () => {
  it("maps the four levels onto the model's own effort names", () => {
    const efforts = ["low", "medium", "high", "xhigh", "max"];
    expect([0, 1, 2, 3].map((level) => mapEffortLevel(level, efforts))).toEqual(["low", "medium", "high", "xhigh"]);
    expect(mapEffortLevel(3, ["low", "medium", "high", "max"])).toBe("max");
    expect(mapEffortLevel(0, ["minimal", "medium", "high"])).toBe("minimal");
  });

  it("falls back to the position when the names differ, and to null without efforts", () => {
    expect(mapEffortLevel(3, ["light", "deep"])).toBe("deep");
    expect(mapEffortLevel(0, ["light", "deep"])).toBe("light");
    expect(mapEffortLevel(2, [])).toBeNull();
  });
});

describe("suggestRoute", () => {
  it("asks one call with runtime/model pairs from the candidates and sums runtime confidence", async () => {
    const smart = fakeSmart("claude/opus", 2, { "codex/gpt-5.5": 0.2, "codex/gpt-5.4-mini": 0.1, "claude/opus": 0.5, "claude/haiku": 0.2 });
    const suggestion = await suggestRoute({
      brief: "Refactor the dispatcher and fix the flaky test", catalog: runtimes(), modelCatalog: MODELS,
      runtimeUnavailable: (runtime) => runtime === "pi", smartModel: smart,
    });

    expect(smart.calls).toHaveLength(1);
    const [call] = smart.calls;
    expect(call!.purpose).toBe("route");
    expect(call!.state).toContain("Refactor the dispatcher");
    expect(Object.keys(call!.questions).sort()).toEqual(["effort", "independent_review", "route", "task_kind"]);
    const route = call!.questions.route!;
    expect(route.type === "choice" && route.options).toEqual(["codex/gpt-5.5", "codex/gpt-5.4-mini", "claude/opus", "claude/haiku"]);

    expect(suggestion).toMatchObject({
      role: "executor",
      runtime: { value: "claude", confidence: 0.7 },
      model: { value: "opus", confidence: 0.714 },
      effort: { value: "high", confidence: 0.7 },
      independentReview: { advisable: true, probability: 0.83 },
      taskKind: { value: "coding", confidence: 0.8 },
      backend: "fake",
      backendModel: "fake-1",
      excluded: [{ runtime: "pi", reason: "unavailable in the runtime health ledger" }],
    });
  });

  it("does not ask about an independent review for a reviewer and offers the runtimes that can run commands first", async () => {
    const smart = fakeSmart("codex/gpt-5.5", 3, { "codex/gpt-5.5": 0.6, "codex/gpt-5.4-mini": 0.4 });
    const suggestion = await suggestRoute({
      brief: "Verify ticket #12", role: "reviewer", context: "The executor ran on runtime claude, model opus.",
      catalog: runtimes(), modelCatalog: MODELS, smartModel: smart,
    });
    const questions = smart.calls[0]!.questions;
    expect(Object.keys(questions).sort()).toEqual(["effort", "route", "task_kind"]);
    expect(questions.route!.type === "choice" && questions.route!.options).toEqual([
      "codex/gpt-5.5", "codex/gpt-5.4-mini", "claude/opus", "claude/haiku", "pi/vibeproxy/gemini-3.7-flash",
    ]);
    expect(smart.calls[0]!.state).toContain("The executor ran on runtime claude");
    expect(suggestion).toMatchObject({
      runtime: { value: "codex", confidence: 1 }, model: { value: "gpt-5.5", confidence: 0.6 },
      effort: { value: "xhigh" }, independentReview: null,
    });
  });

  it("leaves effort to the CLI when the chosen model has no effort setting", async () => {
    const smart = fakeSmart("claude/haiku", 0, { "claude/haiku": 1 });
    const suggestion = await suggestRoute({
      brief: "Convert a CSV to JSON", catalog: runtimes({ claude: true }), modelCatalog: MODELS, smartModel: smart,
    });
    expect(suggestion.model.value).toBe("haiku");
    expect(suggestion.effort).toEqual({ value: null, confidence: 0 });
    expect(suggestion.notes.join(" ")).toMatch(/effort/);
  });

  it("offers the CLI default when a runtime's models are unknown", async () => {
    const smart = fakeSmart("claude/(cli default)", 1, { "codex/gpt-5.5": 0.3, "codex/gpt-5.4-mini": 0.1, "claude/(cli default)": 0.6 });
    const unknownClaude: ModelCatalog = {
      ...MODELS,
      runtimes: MODELS.runtimes.map((entry) => entry.runtime === "claude" ? { ...entry, state: "unknown" as const, models: [] } : entry),
    };
    const suggestion = await suggestRoute({
      brief: "Write a design doc", catalog: runtimes({ codex: true, claude: true }), modelCatalog: unknownClaude, smartModel: smart,
    });
    expect(suggestion.runtime).toEqual({ value: "claude", confidence: 0.6 });
    expect(suggestion.model).toEqual({ value: null, confidence: 1 });
    expect(suggestion.effort.value).toBeNull();
  });

  it("falls back to the hard rules without a SmartModel, or when it fails", async () => {
    const without = await suggestRoute({ brief: "do it", catalog: runtimes(), modelCatalog: MODELS });
    expect(without).toMatchObject({ runtime: { value: "codex", confidence: 0 }, model: { value: null }, backend: null });
    expect(without.notes[0]).toMatch(/not configured/);

    const failing: SmartModel = { backend: "broken", decide: async () => { throw new Error("jev: HTTP 503"); } };
    const failed = await suggestRoute({ brief: "do it", role: "reviewer", catalog: runtimes(), modelCatalog: MODELS, smartModel: failing });
    expect(failed).toMatchObject({ runtime: { value: "codex", confidence: 0 }, backend: null });
    expect(failed.notes[0]).toContain("jev: HTTP 503");
  });

  // 2026-10-16 发布评审：LLM 后端的置信度是固定的 0.6，不能当成真实的概率。
  it("says the confidence is not calibrated when the LLM backend answered", async () => {
    const route = { "codex/gpt-5.5": 1 };
    const fromLlm = await suggestRoute({
      brief: "Fix the bug", catalog: runtimes({ codex: true }), modelCatalog: MODELS, smartModel: fakeSmart("codex/gpt-5.5", 1, route, "llm"),
    });
    expect(fromLlm.backend).toBe("llm");
    expect(fromLlm.notes).toContain("Confidence is not calibrated: the LLM backend answered.");
    const fromJev = await suggestRoute({
      brief: "Fix the bug", catalog: runtimes({ codex: true }), modelCatalog: MODELS, smartModel: fakeSmart("codex/gpt-5.5", 1, route, "jev"),
    });
    expect(fromJev.notes.join(" ")).not.toMatch(/not calibrated/);
  });

  // 2026-10-16 发布评审：先截断再脱敏时，跨在截断处的 token 只剩一个前缀，脱敏规则认不出它。
  it("masks a token cut at the brief or context cap, and keeps the capped text within the cap", async () => {
    const githubToken = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const brief = `${"b".repeat(7_979)} ${githubToken} more brief`;
    const context = `${"c".repeat(3_979)} ${githubToken} more context`;
    expect([brief.indexOf(githubToken), context.indexOf(githubToken)]).toEqual([7_980, 3_980]);
    const smart = fakeSmart("codex/gpt-5.5", 1, { "codex/gpt-5.5": 1 });
    await suggestRoute({ brief, context, catalog: runtimes({ codex: true }), modelCatalog: MODELS, smartModel: smart });
    const state = smart.calls[0]!.state;
    expect(state).not.toContain(githubToken.slice(4, 12));
    const lines = state.split("\n");
    const briefLine = lines.find((line) => line.startsWith("bbb"))!;
    const contextLine = lines.find((line) => line.startsWith("ccc"))!;
    expect(briefLine.length).toBeLessThanOrEqual(8_000);
    expect(briefLine.endsWith("…")).toBe(true);
    expect(contextLine.length).toBeLessThanOrEqual(4_000);
    expect(contextLine.endsWith("…")).toBe(true);
  });

  // cap() 曾经多出一个字符（max 个字符再加 "…"），选项说明因此超过 maxDescriptionChars，整次判断被拒。
  it("keeps a long option note within the description cap", async () => {
    const longNote: ModelCatalog = {
      ...MODELS,
      runtimes: MODELS.runtimes.map((entry) => entry.runtime === "codex" && entry.state === "known"
        ? { ...entry, models: entry.models.map((model) => ({ ...model, note: "n".repeat(1_200) })) }
        : entry),
    };
    const smart = fakeSmart("codex/gpt-5.5", 1, { "codex/gpt-5.5": 1 });
    await suggestRoute({ brief: "Fix the bug", catalog: runtimes({ codex: true }), modelCatalog: longNote, smartModel: smart });
    const route = smart.calls[0]!.questions.route!;
    const description = route.type === "choice" ? route.descriptions?.["codex/gpt-5.5"] ?? "" : "";
    expect(description.length).toBeLessThanOrEqual(1_000);
    expect(description.endsWith("…")).toBe(true);
  });

  it("throws when the hard rules leave no candidate", async () => {
    await expect(suggestRoute({
      brief: "review", role: "reviewer", catalog: runtimes({}), modelCatalog: MODELS,
      smartModel: fakeSmart("x", 0),
    })).rejects.toThrow(/no reviewer runtime is available.*claude: executable not found/);
  });
});
