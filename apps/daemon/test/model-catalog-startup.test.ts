// daemon 启动时问各 CLI 要模型目录（2026-10-15）。Lead 的工具描述在会话建立时生成，所以第一次刷新要在
// Lead 会话建立之前完成（最多等 5 秒），结果也存进 kv，重启后先用它。
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { currentModelCatalog, setModelCatalogForTesting } from "@pi-lead-child/engine";
import { runtimeAdapter } from "@pi-lead-child/runtime";
import { openDb } from "@pi-lead-child/store";

import { startDaemon } from "../src/server.js";

let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const adapters = (["codex", "claude", "pi"] as const).map((id) => runtimeAdapter(id) as { discoverModels?: unknown });
const originals = adapters.map((adapter) => adapter.discoverModels);

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  adapters.forEach((adapter, index) => { adapter.discoverModels = originals[index]; });
  setModelCatalogForTesting(null);
});

function stubLeadFactory(seen: string[]) {
  return async () => {
    // Lead 会话建立的这一刻，目录已经在了。
    seen.push(currentModelCatalog().runtimes.map((entry) => `${entry.runtime}:${entry.state}`).join(","));
    return {
      modelName: "stub/model",
      session: {
        sessionId: "stub", subscribe: () => () => {}, async prompt() {}, async steer() {}, async followUp() {}, dispose() {},
      },
    };
  };
}

describe("the model catalog at daemon start", () => {
  it("is discovered before the Lead session is created, and stored for the next start", async () => {
    setModelCatalogForTesting(null);
    adapters[0]!.discoverModels = async () => ({
      ok: true, source: "codex debug models", account: "Codex 内置的订阅账号", freeformModelPattern: null,
      cliDefaultModel: "gpt-6.1-sol", efforts: ["high"],
      models: [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["high"], defaultEffort: null, note: null }],
    });
    adapters[1]!.discoverModels = async () => ({ ok: false, error: "claude executable not found", source: "claude --help" });
    adapters[2]!.discoverModels = undefined;
    const dir = tempDir("plc-model-catalog-start-");
    const dbPath = join(dir, "plc.db");
    const seen: string[] = [];

    daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stubLeadFactory(seen) as never, modelDiscovery: true, log: () => {},
    });

    expect(seen).toEqual(["codex:known,claude:unknown,pi:unknown"]);
    const db = openDb(dbPath);
    const stored = JSON.parse((db.prepare("SELECT value FROM kv WHERE key='runtime_model_catalog'").get() as { value: string }).value);
    expect(stored.runtimes[0]).toMatchObject({ runtime: "codex", state: "known", cliDefaultModel: "gpt-6.1-sol" });
    db.close();
  });
});
