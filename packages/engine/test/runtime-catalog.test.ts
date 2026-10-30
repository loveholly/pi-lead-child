import { describe, expect, it } from "vitest";
import type { RuntimeId } from "@pi-lead-child/core";
import {
  formatRuntimeCatalogForLead,
  probeChildRuntimeCatalog,
  selectChildRuntime,
  type RuntimeCatalog,
} from "../src/runtime-catalog.js";

function catalog(available: Partial<Record<RuntimeId, string | null>>): RuntimeCatalog {
  return probeChildRuntimeCatalog({
    findExecutable: (id) => available[id] ?? null,
    env: {},
  });
}

describe("probeChildRuntimeCatalog", () => {
  it("marks missing binaries unavailable without inventing a default host", () => {
    const probed = catalog({ codex: "/opt/homebrew/bin/codex", claude: null, pi: null });
    expect(probed.entries.map((entry) => [entry.id, entry.available, entry.executable])).toEqual([
      ["codex", true, "/opt/homebrew/bin/codex"],
      ["claude", false, null],
      ["pi", false, null],
    ]);
    expect(probed.entries.find((entry) => entry.id === "codex")?.capabilities.executableReadOnlyReview)
      .toBe(true);
    // 2026-10-28（lead-tools-and-routing spec D15）：pi 的核查员在沙箱里能跑命令。
    expect(probed.entries.find((entry) => entry.id === "pi")?.capabilities.executableReadOnlyReview)
      .toBe(true);
  });

  it("lists the runtime default model and configured fallbacks", () => {
    const probed = probeChildRuntimeCatalog({
      findExecutable: (id) => id === "codex" ? "/bin/codex" : null,
      env: {
        PLC_CODEX_MODEL: "openai/gpt-5.5",
        PLC_CODEX_FALLBACK_MODELS: "openai/gpt-5.4-mini",
      },
    });
    expect(probed.entries.find((entry) => entry.id === "codex")?.models)
      .toEqual(["openai/gpt-5.5", "openai/gpt-5.4-mini"]);
  });
});

describe("selectChildRuntime", () => {
  it("does not silently default an omitted runtime to pi when a healthier host exists", () => {
    const selected = selectChildRuntime({
      env: {},
      catalog: catalog({
        codex: "/opt/homebrew/bin/codex",
        claude: "/Users/me/.local/bin/claude",
        pi: "/repo/node_modules/.bin/pi",
      }),
    });
    expect(selected).toMatchObject({
      runtime: "codex",
      source: "catalog",
      fallbackFrom: null,
    });
    expect(selected.reason).toContain("omitted");
  });

  it("uses pi only when it is the last healthy candidate", () => {
    expect(selectChildRuntime({
      env: {},
      catalog: catalog({ codex: null, claude: null, pi: "/repo/node_modules/.bin/pi" }),
    }).runtime).toBe("pi");
  });

  it("falls forward from an unavailable requested runtime instead of keeping pi", () => {
    const selected = selectChildRuntime({
      env: {},
      requested: "pi",
      catalog: catalog({
        codex: "/opt/homebrew/bin/codex",
        claude: null,
        pi: null,
      }),
    });
    expect(selected).toMatchObject({
      runtime: "codex",
      source: "catalog",
      fallbackFrom: "pi",
    });
  });

  it("honors an explicit healthy request", () => {
    expect(selectChildRuntime({
      env: {},
      requested: "claude",
      catalog: catalog({
        codex: "/opt/homebrew/bin/codex",
        claude: "/usr/local/bin/claude",
        pi: "/repo/node_modules/.bin/pi",
      }),
    })).toMatchObject({ runtime: "claude", source: "requested", fallbackFrom: null });
  });

  // 2026-10-20：能做可执行只读核查只影响排序：codex 排在前面，点名 claude 当核查员也照用。
  it("prefers a reviewer that can run commands, and accepts any other the caller names", () => {
    expect(selectChildRuntime({
      env: {},
      role: "reviewer",
      catalog: catalog({
        codex: "/opt/homebrew/bin/codex",
        claude: "/usr/local/bin/claude",
        pi: "/repo/node_modules/.bin/pi",
      }),
    }).runtime).toBe("codex");
    expect(selectChildRuntime({
      env: {},
      role: "reviewer",
      requested: "claude",
      catalog: catalog({
        codex: "/opt/homebrew/bin/codex",
        claude: "/usr/local/bin/claude",
        pi: "/repo/node_modules/.bin/pi",
      }),
    })).toMatchObject({ runtime: "claude", source: "requested", fallbackFrom: null });
    expect(selectChildRuntime({
      env: {},
      role: "reviewer",
      catalog: catalog({ codex: null, claude: "/usr/local/bin/claude", pi: "/repo/node_modules/.bin/pi" }),
    }).runtime).toBe("claude");
  });

  it("throws when no healthy runtime remains", () => {
    expect(() => selectChildRuntime({
      env: {},
      catalog: catalog({ codex: null, claude: null, pi: null }),
    })).toThrow(/no healthy child runtime/);
  });
});

// 健康账本（工单 03）：不固定 runtime 时，选择跳过 profile 不可用的 runtime；固定了就不切换。
describe("selectChildRuntime with the health ledger", () => {
  const everyHost = catalog({ codex: "/bin/codex", claude: "/bin/claude", pi: "/bin/pi" });
  const codexDown = (runtime: RuntimeId): boolean => runtime === "codex";

  it("skips an unavailable profile when the runtime is not pinned", () => {
    expect(selectChildRuntime({ env: {}, catalog: everyHost, unavailable: codexDown }).runtime).toBe("claude");
    // 环境变量给的只是默认值，不算固定。
    expect(selectChildRuntime({ env: { PLC_CHILD_RUNTIME: "codex" }, catalog: everyHost, unavailable: codexDown }))
      .toMatchObject({ runtime: "claude", fallbackFrom: "codex" });
  });

  it("keeps a pinned runtime even when its profile is unavailable", () => {
    expect(selectChildRuntime({ env: {}, catalog: everyHost, requested: "codex", unavailable: codexDown }))
      .toMatchObject({ runtime: "codex", fallbackFrom: null });
  });

  it("keeps the first capable host when every profile is unavailable, so the request can wait", () => {
    expect(selectChildRuntime({ env: {}, catalog: everyHost, unavailable: () => true }).runtime).toBe("codex");
  });
});

describe("formatRuntimeCatalogForLead", () => {
  it("exposes health, models, and review capability for Lead tool descriptions", () => {
    const text = formatRuntimeCatalogForLead(catalog({
      codex: "/opt/homebrew/bin/codex",
      claude: null,
      pi: "/repo/node_modules/.bin/pi",
    }));
    expect(text).toContain("派发时从目录选择 runtime");
    expect(text).toContain("不会默认落到 Pi");
    expect(text).toContain("codex: 可用");
    expect(text).toContain("claude: 不可用");
    // 2026-10-28：三个 runtime 的核查员都在沙箱里能跑命令（lead-tools-and-routing spec D15）。
    expect(text).toContain("核查时能跑命令（只读）");
    expect(text).not.toContain("核查时只读代码、不能跑命令");
  });
});
