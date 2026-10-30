// Lead 的运行环境说明（工单 13，spec D17）。
// 2026-10-17 用户问 Lead「jev 在你的会话里面激活了多少次」，Lead 回答「查不到 jev 指什么」：提示词里没有 Jev，
// 也没有说调用记在哪里。这里测生成说明的纯函数，和读数据源拼快照的函数。
// 2026-10-30 用户：这一节不该写死这么多内容，有泄漏隐私的嫌疑（密钥名、vibeproxy）。系统提示里的这一节只写组件和用什么查；
// 现在的值在 get_environment 的结果里（renderEnvironmentDetails）。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { estimateTokens } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";
import { setModelCatalogForTesting } from "@pi-lead-child/engine";
import { createItem, markRuntimeDegraded, openDb, recordRuntimeHealthFailure } from "@pi-lead-child/store";
import { typedFailure } from "@pi-lead-child/runtime";
import {
  collectLeadEnvironment, ENVIRONMENT_TOKEN_BUDGET, renderEnvironmentDetails, renderLeadEnvironment, type LeadEnvironmentSnapshot,
} from "../src/environment.js";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";

afterEach(() => setModelCatalogForTesting(null));

const SNAPSHOT: LeadEnvironmentSnapshot = {
  lead: { model: "vibeproxy/claude-sonnet-5", models: ["vibeproxy/claude-sonnet-5", "acme/gpt-5.5"], configProblem: null },
  smartModel: { backend: "jev→llm", llm: "vibeproxy/claude-haiku-5-5" },
  decisionModel: { model: "jev-latest", host: "api.typesafe.ai", keySet: true, problem: null },
  memory: { state: "healthy", backend: "hindsight", reranker: "decision", index: { notes: 146, indexed: 145 } },
  runtimes: [
    { runtime: "claude", catalog: "known", models: 8, problems: [] },
    {
      runtime: "codex", catalog: "known", models: 12,
      problems: [{ model: "gpt-5.5", code: "model_unsupported", needs: "none", incidentId: 3 }],
    },
    { runtime: "pi", catalog: "unknown", models: 0, problems: [] },
  ],
  connections: [
    { label: "GitHub", state: "connected" },
    { label: "Jira", state: "needs_reauth" },
    { label: "Notion", state: "not_connected" },
  ],
};

// 沙箱里一个绑定了主机的密钥（core 的 sandboxSecrets）。值不会出现在任何文字里。
const SECRET_ENV = { PLC_SANDBOX_SECRET_HOSTS: "EXAMPLE_API_KEY=api.example.test", EXAMPLE_API_KEY: "example-secret-value" };

describe("renderLeadEnvironment（系统提示里的这一节）", () => {
  // 回归（2026-10-30）：以前这一节写着密钥名和主机、模型和服务商、决策模型的主机、连接，每一轮都发给模型服务商。
  it("carries none of the current values: no secret names or hosts, models, providers, service hosts or connections", () => {
    const text = renderLeadEnvironment();
    const details = renderEnvironmentDetails(SNAPSHOT, SECRET_ENV);
    for (const value of [
      "EXAMPLE_API_KEY", "api.example.test", "example-secret-value", "vibeproxy", "claude-sonnet-5", "acme/gpt-5.5",
      "jev-latest", "api.typesafe.ai", "GitHub", "Jira", "145/146", "gpt-5.5", "lead.models：",
    ]) {
      expect(text).not.toContain(value);
    }
    // 这些值都在 get_environment 的结果里（值本身除外）。
    expect(details).toContain("EXAMPLE_API_KEY → api.example.test");
    expect(details).not.toContain("example-secret-value");
    expect(details).toContain("vibeproxy/claude-sonnet-5");
  });

  it("points Lead at get_environment for the current values, and at get_system_usage for call counts", () => {
    const text = renderLeadEnvironment();
    expect(text).toContain("用 get_environment 现查");
    expect(text).toContain("你用的模型和备选的顺序：get_environment");
    expect(text).toContain("有哪些、各绑定哪个主机：get_environment");
    expect(text).toContain("现在的状态和写入进度：get_environment");
    expect(text).toContain("调用次数用 get_system_usage 查");
  });

  it("explains Jev: what it is, where it runs, which features call it, and where its calls are recorded", () => {
    const text = renderLeadEnvironment();
    expect(text).toContain("## 你运行的环境");
    expect(text).toContain("决策模型 Jev：TypeSafe 托管的类型化判断模型");
    expect(text).toContain("Jev 不在你的会话里运行");
    expect(text).toContain("suggest_route");
    expect(text).toContain("记忆召回的重排序");
    expect(text).toContain("decision_model.called");
    expect(text).toContain("smart-model/decisions.jsonl");
  });

  // Lead 回答「系统为什么这样」时要查代码，这一节写出代码在哪里。
  it("lists the components, Lead's own limits, where the system's code is, and where each record lives", () => {
    const text = renderLeadEnvironment();
    for (const line of [
      "- daemon：", "- supervisor：", "- 网关：", "- runtime（执行 child 的 CLI）：", "- 记忆服务 Hindsight：", "- 连接（第三方账号）：",
      "沙箱里的 bash", "外部消息叫醒的一轮里你不跑命令", "你看不到 child 会话的内部",
      "### 记在哪里、用什么读", "read_lead_turns", "get_runtime_health", "list_connections",
    ]) {
      expect(text).toContain(line);
    }
    expect(text).toMatch(/pi-lead-child 自己的代码在 \/.+。回答「系统为什么这样做」时/);
  });

  // 用户 2026-10-30：用户让 Lead 读 Slack，Lead 读完说「这一轮读了 Slack，不能再跑命令」就停了。代码只在外部消息叫醒的一轮里拦
  // bash（hands.ts 的 handsBlockedInTurn），用户本人的一轮照常能用；说明不能比代码严。
  it("tells Lead that only a turn an external message woke stops its commands, not reading Slack in the user's own turn", () => {
    const text = renderLeadEnvironment();
    expect(text).toContain("外部消息叫醒的一轮里你不跑命令、不写文件。");
    expect(text).not.toContain("读过外部内容的一轮里你不跑命令");
    expect(LEAD_SYSTEM_PROMPT).toContain("用户让你读 Slack 这类外部内容以后也一样");
    expect(LEAD_SYSTEM_PROMPT).toContain("风险你自己判断");
  });

  // 用户可能用任何一个名字称呼同一个东西。
  it("gives a one-line gloss for every system term", () => {
    const text = renderLeadEnvironment();
    const glossary = text.slice(text.indexOf("### 名词"));
    for (const term of ["Jev", "SmartModel", "决策模型", "runtime", "child", "reviewer", "Run", "Hindsight"]) {
      expect(glossary).toMatch(new RegExp(`^- ${term}：`, "m"));
    }
  });

  it("is the same text every time, so it never invalidates the prompt cache, and fits its budget", () => {
    expect(renderLeadEnvironment()).toBe(renderLeadEnvironment());
    expect(renderLeadEnvironment()).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(estimateTokens(renderLeadEnvironment())).toBeLessThan(ENVIRONMENT_TOKEN_BUDGET);
  });
});

describe("renderEnvironmentDetails（get_environment 的结果）", () => {
  // 2026-10-19：「不用 codex」只在 Lead 的笔记里，系统和 Lead 的提示都不知道 codex 停用了。现在停用是设置里的开关。
  it("says which runtimes the user disabled", () => {
    const text = renderEnvironmentDetails({
      ...SNAPSHOT,
      runtimes: [{ runtime: "codex", catalog: "known", models: 12, problems: [], disabled: true }],
    }, {});
    expect(text).toContain("  - codex：已被用户停用（设置 → 执行器），派发、核查和选型都跳过它，点名它会报错；模型目录有 12 个模型；健康。");
  });

  it("reads the disabled list from the environment when it collects the snapshot", () => {
    const db = openDb(join(tempDir("plc-env-disabled-"), "plc.db"));
    const snapshot = collectLeadEnvironment({
      db, dataDir: tempDir("plc-env-disabled-data-"), leadModel: () => null, smartModel: () => null,
      env: { PLC_DISABLED_RUNTIMES: "codex" },
    });
    expect(snapshot.runtimes?.find((entry) => entry.runtime === "codex")?.disabled).toBe(true);
  });

  it("lists Lead's models, the decision model, memory, runtimes, connections and the sandbox secrets", () => {
    const text = renderEnvironmentDetails(SNAPSHOT, SECRET_ENV);
    for (const line of [
      "- 你的模型：现在用 vibeproxy/claude-sonnet-5。config.json 的 lead.models：vibeproxy/claude-sonnet-5、acme/gpt-5.5",
      "- 决策模型 Jev：已配置（模型 jev-latest，主机 api.typesafe.ai）。SmartModel 现在的后端：jev→llm；兜底的 LLM 是 vibeproxy/claude-haiku-5-5。",
      "- 记忆服务 Hindsight：运行中，重排序用决策模型。已写入 145/146 条笔记（没写完的召回不到，见设置 → 记忆）。",
      "  - claude：模型目录有 8 个模型；健康。",
      "  - codex：模型目录有 12 个模型；模型 gpt-5.5 不可用（故障 #3，code=model_unsupported）。",
      "  - pi：模型目录还不知道；健康。",
      "- 连接（第三方账号）：GitHub（已连接）、Jira（要用户重新授权）。没有连接：Notion。",
      "EXAMPLE_API_KEY → api.example.test",
    ]) {
      expect(text).toContain(line);
    }
  });

  it("is the same text for the same snapshot, and carries no time or call count", () => {
    expect(renderEnvironmentDetails(structuredClone(SNAPSHOT), {})).toBe(renderEnvironmentDetails(SNAPSHOT, {}));
    expect(renderEnvironmentDetails(SNAPSHOT, {})).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  // 验收：改 lead.models 或决策模型设置后，下一次查到的不同。
  it("changes when lead.models or the decision model settings change", () => {
    const base = renderEnvironmentDetails(SNAPSHOT, {});
    const models = renderEnvironmentDetails({ ...SNAPSHOT, lead: { ...SNAPSHOT.lead, models: ["acme/gpt-5.5"] } }, {});
    expect(models).not.toBe(base);
    expect(models).toContain("config.json 的 lead.models：acme/gpt-5.5（");

    const noKey = renderEnvironmentDetails({
      ...SNAPSHOT,
      smartModel: { backend: "llm", llm: "vibeproxy/claude-haiku-5-5" },
      decisionModel: { ...SNAPSHOT.decisionModel!, keySet: false },
    }, {});
    expect(noKey).not.toBe(base);
    expect(noKey).toContain("- 决策模型 Jev：没有配置 key，不调用 Jev。SmartModel 现在的后端：llm");
  });

  it("says plainly what the daemon did not provide", () => {
    const text = renderEnvironmentDetails({
      ...SNAPSHOT, decisionModel: null, memory: null, connections: null, runtimes: null,
      smartModel: { backend: "llm", llm: "stub/m" },
    }, {});
    expect(text).toContain("daemon 没有提供决策模型的设置，SmartModel 不调用 Jev");
    expect(text).toContain("daemon 没有提供记忆服务的状态。daemon 不托管记忆服务时，search_notes 只用笔记的全文检索");
    expect(text).toContain("读不到连接列表");
    expect(text).toContain("读不到模型目录和健康账本");
  });

  it("caps and masks a settings problem", () => {
    const text = renderEnvironmentDetails({
      ...SNAPSHOT,
      decisionModel: { ...SNAPSHOT.decisionModel!, problem: `地址不合法：https://u:p@x.test/?api_key=sk-live-0123456789abcdef ${"x".repeat(400)}` },
    }, {});
    expect(text).toContain("设置有问题：地址不合法");
    expect(text).not.toContain("sk-live-0123456789abcdef");
    expect(text).not.toContain("x".repeat(200));
  });

  it("caps long lists and says how many more there are", () => {
    const crowded: LeadEnvironmentSnapshot = {
      ...SNAPSHOT,
      runtimes: [{
        runtime: "rt", catalog: "known", models: 40,
        problems: Array.from({ length: 30 }, (_, model) => ({ model: `model-${model}`, code: "auth_required", needs: "login", incidentId: 100 + model })),
      }],
      connections: Array.from({ length: 60 }, (_, index) => ({ label: `Service ${index}`, state: "connected" })),
    };
    const text = renderEnvironmentDetails(crowded, {});
    expect(text).toContain("，另有 25 条");
    expect(text).toContain("，另有 40 条");
  });
});

describe("collectLeadEnvironment", () => {
  it("re-reads lead.models from config.json each time, so get_environment follows the new config", () => {
    const dataDir = tempDir("plc-lead-env-");
    const db = openDb(join(dataDir, "plc.db"));
    try {
      const write = (models: string[]) => writeFileSync(join(dataDir, "config.json"), JSON.stringify({ lead: { models } }));
      const sources = {
        db, dataDir, env: {}, leadModel: () => "stub/m",
        smartModel: () => ({ backend: "llm", llm: "stub/m" }),
      };
      write(["stub/m"]);
      const before = collectLeadEnvironment(sources);
      expect(before.lead).toEqual({ model: "stub/m", models: ["stub/m"], configProblem: null });
      write(["stub/m", "stub/m2"]);
      const after = collectLeadEnvironment(sources);
      expect(after.lead.models).toEqual(["stub/m", "stub/m2"]);
      expect(renderEnvironmentDetails(after, {})).not.toBe(renderEnvironmentDetails(before, {}));
    } finally {
      db.close();
    }
  });

  it("reads the decision model and memory status from the daemon, and keeps going when one source fails", () => {
    const dataDir = tempDir("plc-lead-env-");
    const db = openDb(join(dataDir, "plc.db"));
    try {
      writeFileSync(join(dataDir, "config.json"), "{ not json");
      const snapshot = collectLeadEnvironment({
        db, dataDir, env: {}, leadModel: () => "stub/m",
        smartModel: () => ({ backend: "jev→llm", llm: "stub/m" }),
        connections: { list: () => { throw new Error("hub is down"); } },
        daemon: () => ({
          decisionModel: {
            baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKeySet: true, apiKeySource: "settings",
            apiKeyHost: "api.typesafe.ai", problem: null,
          },
          memory: null,
        }),
      });
      expect(snapshot.lead.configProblem).toMatch(/config\.json/);
      expect(snapshot.decisionModel).toEqual({ model: "jev-latest", host: "api.typesafe.ai", keySet: true, problem: null });
      expect(snapshot.connections).toBeNull();
      expect(snapshot.runtimes).not.toBeNull();
      expect(renderEnvironmentDetails(snapshot, {})).toContain("读不到 config.json 的 lead.models");
    } finally {
      db.close();
    }
  });
});

describe("collectLeadEnvironment and short-lived states", () => {
  // 短暂的状态用 get_runtime_health、list_connections 现查，不当作故障列出。
  it("lists an unavailable runtime, but not a degraded one, and lists a degraded connection as connected", () => {
    const dataDir = tempDir("plc-lead-env-");
    const db = openDb(join(dataDir, "plc.db"));
    try {
      const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
      const profile = (runtime: "codex" | "claude") => ({ runtime, executable: `/usr/local/bin/${runtime}`, configDir: null });
      recordRuntimeHealthFailure(db, {
        profile: profile("codex"), model: null,
        failure: typedFailure("auth_required", { errorCode: null, message: "login expired" }), itemId, runId: null,
      });
      markRuntimeDegraded(db, { profile: profile("claude"), at: new Date(), recoverAt: new Date(Date.now() + 3_600_000) });

      const snapshot = collectLeadEnvironment({
        db, dataDir, env: {}, leadModel: () => "stub/m", smartModel: () => null,
        connections: { list: () => [{ label: "GitHub", state: "degraded" }, { label: "Notion", state: "not_connected" }] as never },
      });
      const codex = snapshot.runtimes!.find((entry) => entry.runtime === "codex")!;
      expect(codex.problems).toEqual([expect.objectContaining({ model: null, code: "auth_required", needs: "login" })]);
      expect(snapshot.runtimes!.find((entry) => entry.runtime === "claude")?.problems ?? []).toEqual([]);
      expect(snapshot.connections).toEqual([{ label: "GitHub", state: "connected" }, { label: "Notion", state: "not_connected" }]);
      const text = renderEnvironmentDetails(snapshot, {});
      expect(text).toMatch(/codex：.*整个 runtime 不可用（故障 #\d+，code=auth_required，要用户做：login）/);
      expect(text).toContain("GitHub（已连接）");
    } finally {
      db.close();
    }
  });
});

describe("Lead prompt rules for unknown system terms", () => {
  it("tells Lead to look up the environment and the event log before it says it cannot find a term", () => {
    for (const anchor of [
      "「你运行的环境」一节", "get_environment", "get_system_usage", "不认识的系统名词", "它是什么、它在哪里运行、你能看到它的什么",
      "不要只回答「查不到」", "先说明实际结构，再回答", "明确说 0 次",
    ]) {
      expect(LEAD_SYSTEM_PROMPT).toContain(anchor);
    }
  });
});
