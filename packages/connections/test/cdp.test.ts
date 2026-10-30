// CDP 作为一个连接接进连接中心（landing.md C5）：用户照常添加自定义 MCP（addCustom），连接中心按服务器地址认出它，
// 给它别名 cdp，只开放它的只读工具：服务器上别的工具（包括写工具）对谁都看不到、调不了；清单按别名写也认。
// CDP 的服务器是假的（testing/fake-vendor.ts，地址换成 CDP 的地址）。
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { computeRunGrant, DEFAULT_INTENT_GRANT_BOUNDS } from "@pi-lead-child/protocol";
import { createItem, createRun, getConnectionByServer, insertRunGrant, listRunToolCalls, openDb, type Db } from "@pi-lead-child/store";
import { KNOWN_SERVERS, knownServer } from "../src/catalog.js";
import { ConnectionHub } from "../src/hub.js";
import { Vault } from "../src/vault.js";
import { FakeVendor } from "../testing/fake-vendor.js";

const CDP_URL = "https://mcp.acme.org/cdp/mcp";
const tool = (name: string, readOnly: boolean) => ({
  name, description: name, inputSchema: { type: "object" }, ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
});

let db: Db;
let vendor: FakeVendor;

beforeEach(() => {
  db = openDb(join(tempDir("plc-cdp-"), "plc.db"));
  vendor = new FakeVendor(() => Date.parse("2026-10-22T08:00:00.000Z"), {
    mcpUrl: CDP_URL, issuer: "https://auth.acme.test",
    tools: [
      // 文档里的只读工具：一个没标 readOnlyHint，照样按只读算。
      tool("search_audiences", true), tool("aggregate_audiences", false), tool("get_audience_definitions", true),
      // 不在名单里的：一个写工具、一个标了只读的新工具。
      tool("delete_audience", false), tool("export_contacts", true),
    ],
    callResult: (name) => JSON.stringify({ tool: name, items: [{ company: "Acme", mrr: 1200 }] }),
  });
});

async function connectCdp(): Promise<{ hub: ConnectionHub; key: string }> {
  const hub = new ConnectionHub({
    db, vault: new Vault(randomBytes(32)), config: { clients: {} }, redirectUri: () => "http://127.0.0.1:1/oauth/callback",
    fetch: vendor.fetch, gh: { token: async () => null }, ghInstalled: () => false,
  });
  const started = await hub.addCustom(CDP_URL);
  if (started.flow !== "browser") throw new Error("expected a browser flow");
  const callback = vendor.approve(started.authorizeUrl);
  await hub.completeCallback({ ...callback, error: null, errorDescription: null });
  return { hub, key: `custom-${getConnectionByServer(db, CDP_URL)!.id}` };
}

describe("CDP as a read-only connection", () => {
  it("recognizes the server by its address, with a label and what it can do", async () => {
    expect(knownServer(`${CDP_URL}/`)).toBe(KNOWN_SERVERS[0]);
    const { hub, key } = await connectCdp();
    expect(hub.get(key)).toMatchObject({ label: "CDP", capability: expect.stringContaining("客户数据"), tools: { total: 3, readOnly: 3, write: 0 } });
    expect(hub.get("cdp").key).toBe(key);
  });

  it("opens only the documented read tools, to every role, by alias too", async () => {
    const { hub, key } = await connectCdp();
    for (const role of ["lead", "executor", "reviewer"] as const) {
      const names = (await hub.searchTools(role, { connection: "cdp" })).map((entry) => entry.name).sort();
      expect(names).toEqual(["aggregate_audiences", "get_audience_definitions", "search_audiences"]);
    }
    await expect(hub.callTool("cdp", "aggregate_audiences", {}, { role: "reviewer" })).resolves.toMatchObject({ isError: false });
    for (const name of ["delete_audience", "export_contacts"]) {
      await expect(hub.callTool(key, name, {}, { role: "lead", confirmed: true })).rejects.toMatchObject({ code: "unknown_tool" });
    }
    expect(() => hub.requestWrite(key, "delete_audience", {}, "删掉")).toThrow(/没有工具/);
    expect(vendor.calls.filter((call) => call.method === "tools/call").map((call) => call.tool)).toEqual(["aggregate_audiences"]);
  });

  it("lets a run whose grant names cdp query it, and records what it read", async () => {
    const { hub, key } = await connectCdp();
    const itemId = createItem(db, { title: "通道派的工单", brief: "b", createdBy: "system", purpose: "lookup" });
    const runId = createRun(db, { itemId, purpose: "lookup" });
    const { grant } = computeRunGrant({ intent: "knowledge", scope: {}, resolveLocalRepo: () => null });
    insertRunGrant(db, { itemId, runId, grant, bound: DEFAULT_INTENT_GRANT_BOUNDS.knowledge, scope: {} });
    expect(grant.rules.map((rule) => rule.label)).toEqual(["只读 cdp"]);

    const tools = await hub.searchTools("executor", {}, { runId });
    expect(tools.map((entry) => `${entry.connection}.${entry.name}`).sort()).toEqual([
      `${key}.aggregate_audiences`, `${key}.get_audience_definitions`, `${key}.search_audiences`,
    ]);
    const result = await hub.callTool("cdp", "search_audiences", { query: "Acme" }, { role: "executor", runId });
    expect(result.text).toContain('"mrr":1200');
    await expect(hub.callTool("cdp", "delete_audience", {}, { role: "executor", runId })).rejects.toMatchObject({ code: "unknown_tool" });
    expect(hub.runReads(runId).content().texts).toEqual([
      { connections: ["cdp", key], tool: "search_audiences", text: result.text },
    ]);
    expect(listRunToolCalls(db, runId).map((entry) => `${entry.tool}:${entry.decision}`)).toEqual([
      "search_audiences:allowed", "delete_audience:refused",
    ]);
  });
});
