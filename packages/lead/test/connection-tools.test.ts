// Lead 的三个连接工具：查连接、查工具、调工具。写入在「先问我」策略下不执行，只拿到确认号；
// 没连接的服务返回结构化的 not_connected，Lead 据此发连接卡。
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "@pi-lead-child/store";
import { ConnectionHub, Vault } from "@pi-lead-child/connections";
import { FakeVendor } from "@pi-lead-child/connections/testing";
import { estimateTokens } from "@pi-lead-child/core";
import {
  CONNECTION_QUIET_TOOLS, connectionResultBudget, createConnectionTools, type ConnectionResultBudget,
} from "../src/connection-tools.js";

async function setup() {
  const db = openDb(join(tempDir("plc-lead-conn-"), "plc.db"));
  const vendor = new FakeVendor(() => Date.now());
  const hub = new ConnectionHub({
    db, vault: new Vault(randomBytes(32)), config: { clients: {} }, redirectUri: () => "http://127.0.0.1:47130/oauth/callback",
    fetch: vendor.fetch, gh: { token: async () => null }, ghInstalled: () => false,
  });
  const started = await hub.addCustom(vendor.mcpUrl);
  if (started.flow !== "browser") throw new Error("expected a browser flow");
  await hub.completeCallback({ ...vendor.approve(started.authorizeUrl), error: null, errorDescription: null });
  const key = hub.list().find((item) => item.provider === "custom")!.key;
  const tools = Object.fromEntries(createConnectionTools(hub).map((tool) => [tool.name, tool]));
  const call = async (name: string, params: Record<string, unknown>) => {
    const result = await (tools[name] as any).execute("call-1", params, undefined, undefined, {});
    return result.content[0].text as string;
  };
  const details = async (name: string, params: Record<string, unknown>) =>
    (await (tools[name] as any).execute("call-1", params, undefined, undefined, {})).details;
  return { hub, vendor, key, call, details };
}

describe("Lead's connection tools", () => {
  it("lists connections and finds tools by keyword", async () => {
    const { key, call } = await setup();
    const listed = JSON.parse(await call("list_connections", {}));
    expect(listed.connections.find((item: any) => item.key === key)).toMatchObject({ state: "connected", usableByLead: true });
    const found = JSON.parse(await call("search_connection_tools", { query: "page" }));
    expect(found.tools.map((tool: any) => [tool.name, tool.read_only])).toEqual([["search_pages", true], ["update_page", false]]);
  });

  it("runs a read tool, and returns a confirmation id for a write under the confirm policy", async () => {
    const { key, vendor, call } = await setup();
    expect(await call("call_connection_tool", { connection: key, tool: "search_pages", arguments: { query: "周报" } }))
      .toContain("called search_pages");
    const write = JSON.parse(await call("call_connection_tool", { connection: key, tool: "update_page", arguments: { id: "7" }, summary: "改标题" }));
    expect(write).toMatchObject({ ok: false, status: "confirmation_required", confirmation_id: expect.stringMatching(/^cfm_/) });
    expect(write.user_action).toEqual({
      kind: "confirm_write", target: `connection_confirmation:${write.confirmation_id}`, title: "允许这次写入", reason: "改标题",
    });
    expect(vendor.calls.some((entry) => entry.tool === "update_page")).toBe(false);
  });

  it("tells Lead to send a connect card for a service that is not connected", async () => {
    const { call, details } = await setup();
    // 系统只认工具自己写的 details.userAction（不解析外部 MCP 的正文）：登记等待用它。
    expect((await details("call_connection_tool", { connection: "notion", tool: "search", arguments: {} })).userAction)
      .toMatchObject({ kind: "authorize", target: "connection:notion" });
    const result = JSON.parse(await call("call_connection_tool", { connection: "notion", tool: "search", arguments: {} }));
    // 要用户做的事是结构化数据（2026-10-19）：Lead 原样放进 UserAction 卡，系统按它登记等待。
    expect(result).toMatchObject({
      ok: false, error: "not_connected", connection: "notion", next: expect.stringContaining("UserAction"),
      user_action: { kind: "authorize", target: "connection:notion", title: expect.stringContaining("连接"), reason: expect.any(String) },
    });
  });
});

// 2026-10-16：GitHub 连接的几次结果把 Lead 的上下文从约 12 万推到 15 万 token，随后溢出，压缩跑了 70 分钟也失败了。
// 连接工具的结果有大小预算：超出时只给前一段，结尾写明截断了多少、怎样取下一段和全文。
// 预算按估算的 token 算（PLC_LEAD_CONNECTION_RESULT_TOKENS）。旧的 PLC_LEAD_CONNECTION_RESULT_CHARS 设置了时照旧按字数算。
// 下面前几项用按字数的预算，测的是兼容的那条路径；按 token 的测试在后面的 describe 里。
describe("a connection tool result over the budget", () => {
  // 只返回一段固定文字的连接（hub 的 callTool 已经把 MCP 结果变成文字）。hubTruncated：hub 自己的上限（6 万字）截过。
  function bigResult(text: string, options: { budget?: number | ConnectionResultBudget; hubTruncated?: boolean } = {}) {
    const calls: string[] = [];
    const hub = {
      needsConfirmation: () => false,
      callTool: async (_key: string, tool: string) => {
        calls.push(tool);
        return { text, truncated: options.hubTruncated ?? false, isError: false };
      },
    };
    // 数字是按字数的预算（兼容的那条路径）。
    const resultBudget: ConnectionResultBudget | undefined = typeof options.budget === "number"
      ? { unit: "chars", limit: options.budget }
      : options.budget;
    const tools = Object.fromEntries(createConnectionTools(hub as never, resultBudget === undefined ? {} : { resultBudget })
      .map((tool) => [tool.name, tool]));
    const call = async (name: string, params: Record<string, unknown>) => {
      const result = await (tools[name] as any).execute("call-1", params, undefined, undefined, {});
      return result.content[0].text as string;
    };
    return { call, calls, tools };
  }

  // 每 10 个字写一个序号，任何一段都不会在别处重复出现。
  const body = (length: number) => Array.from({ length: Math.ceil(length / 10) }, (_, index) => `${String(index).padStart(9, "0")}|`)
    .join("").slice(0, length);

  it("is cut at the budget, says how much was left out, and gives the rest by offset without calling the service again", async () => {
    const text = body(25_000);
    const { call, calls } = bigResult(text, { budget: 10_000 });

    const first = await call("call_connection_tool", { connection: "github", tool: "list_issues", arguments: {} });
    expect(first.startsWith(text.slice(0, 10_000))).toBe(true);
    expect(first).not.toContain(text.slice(10_000, 10_050));
    expect(first.length).toBeLessThan(10_000 + 600);
    expect(first).toContain("共 25000 字");
    expect(first).toContain("还有 15000 字");
    const resultId = /result_id="(res_[\w-]+)"/.exec(first)?.[1];
    expect(resultId).toBeTruthy();
    expect(first).toContain("offset=10000");

    const second = await call("read_connection_result", { result_id: resultId, offset: 10_000 });
    expect(second.startsWith(text.slice(10_000, 20_000))).toBe(true);
    expect(second).toContain("offset=20000");
    const last = await call("read_connection_result", { result_id: resultId, offset: 20_000 });
    expect(last.startsWith(text.slice(20_000))).toBe(true);
    expect(last).toContain("已经是结尾");
    // 全文：offset 0，max_chars 给到总长。
    const whole = await call("read_connection_result", { result_id: resultId, offset: 0, max_chars: 25_000 });
    expect(whole.startsWith(text)).toBe(true);
    expect(calls).toEqual(["list_issues"]);
  });

  it("is left whole when it fits the budget", async () => {
    const text = body(9_000);
    const { call } = bigResult(text, { budget: 10_000 });
    expect(await call("call_connection_tool", { connection: "github", tool: "list_issues", arguments: {} })).toBe(text);
  });

  it("reads a token budget from PLC_LEAD_CONNECTION_RESULT_TOKENS, with a default of 3000", () => {
    expect(connectionResultBudget({})).toEqual({ unit: "tokens", limit: 3_000 });
    expect(connectionResultBudget({ PLC_LEAD_CONNECTION_RESULT_TOKENS: "2000" })).toEqual({ unit: "tokens", limit: 2_000 });
    expect(connectionResultBudget({ PLC_LEAD_CONNECTION_RESULT_TOKENS: "abc" })).toEqual({ unit: "tokens", limit: 3_000 });
    expect(connectionResultBudget({ PLC_LEAD_CONNECTION_RESULT_TOKENS: "0" })).toEqual({ unit: "tokens", limit: 3_000 });
  });

  it("still honours the old PLC_LEAD_CONNECTION_RESULT_CHARS as a budget in characters", () => {
    expect(connectionResultBudget({ PLC_LEAD_CONNECTION_RESULT_CHARS: "4000" })).toEqual({ unit: "chars", limit: 4_000 });
    expect(connectionResultBudget({ PLC_LEAD_CONNECTION_RESULT_CHARS: "abc" })).toEqual({ unit: "tokens", limit: 3_000 });
    // 两个都设置了时，新的 token 预算优先。
    expect(connectionResultBudget({ PLC_LEAD_CONNECTION_RESULT_CHARS: "4000", PLC_LEAD_CONNECTION_RESULT_TOKENS: "500" }))
      .toEqual({ unit: "tokens", limit: 500 });
  });

  it("cuts by characters when only the old variable is set", async () => {
    const budget = connectionResultBudget({ PLC_LEAD_CONNECTION_RESULT_CHARS: "1000" });
    // 1000 个汉字约 1000 token，超出缺省的 token 预算很多；按字数的预算照样只给前 1000 字。
    const text = "汉".repeat(3_000);
    const { call } = bigResult(text, { budget });
    const first = await call("call_connection_tool", { connection: "github", tool: "list_issues", arguments: {} });
    expect(first.startsWith(text.slice(0, 1_000))).toBe(true);
    expect(first).not.toContain(text.slice(0, 1_001));
    expect(first).toContain("offset=1000");
  });

  it("says the service's own paging is the way to get more when the hub already cut the result", async () => {
    const { call } = bigResult(body(60_000), { budget: 10_000, hubTruncated: true });
    const first = await call("call_connection_tool", { connection: "github", tool: "list_issues", arguments: {} });
    expect(first).toContain("分页");
  });

  it("is a read-only tool, so a quiet Lead turn that only reads a result leaves no trace", () => {
    expect(CONNECTION_QUIET_TOOLS).toContain("read_connection_result");
  });

  it("tells Lead when a result id is unknown or expired", async () => {
    const { call } = bigResult("x", { budget: 10_000 });
    const result = JSON.parse(await call("read_connection_result", { result_id: "res_missing" }));
    expect(result).toMatchObject({ ok: false, error: "unknown_result" });
  });
});

// 按估算的 token 截断：同样的预算，英文结果给的字数约是中文结果的 4 倍，两者的 token 差不多。
describe("a connection tool result over a token budget", () => {
  function tokenResult(text: string, limit: number) {
    const hub = {
      needsConfirmation: () => false,
      callTool: async () => ({ text, truncated: false, isError: false }),
    };
    const tools = Object.fromEntries(createConnectionTools(hub as never, { resultBudget: { unit: "tokens", limit } })
      .map((tool) => [tool.name, tool]));
    const call = async (name: string, params: Record<string, unknown>) => {
      const result = await (tools[name] as any).execute("call-1", params, undefined, undefined, {});
      return result.content[0].text as string;
    };
    const first = () => call("call_connection_tool", { connection: "github", tool: "list_issues", arguments: {} });
    return { call, first };
  }
  // 结尾说明之前的那一段（说明以两个换行开头）。
  const shown = (page: string) => page.slice(0, page.lastIndexOf("\n\n["));
  const resultIdOf = (page: string) => /result_id="(res_[\w-]+)"/.exec(page)?.[1];

  it("gives an English result four characters per token and a Chinese result one", async () => {
    const english = "abcd".repeat(5_000);                         // 20000 字，5000 token
    const chinese = "连接工具的结果".repeat(2_000);                // 14000 字，14000 token
    const englishPage = await tokenResult(english, 1_000).first();
    const chinesePage = await tokenResult(chinese, 1_000).first();
    expect(shown(englishPage)).toBe(english.slice(0, 4_000));
    expect(shown(chinesePage)).toBe(chinese.slice(0, 1_000));
    expect(englishPage).toContain("offset=4000");
    expect(chinesePage).toContain("offset=1000");
    // 写明剩下多少字、多少 token，以及取下一段的方式。
    expect(englishPage).toContain("结果共 20000 字，约 5000 token");
    expect(englishPage).toContain("后面还有 16000 字，约 4000 token，没有给你");
    expect(chinesePage).toContain("结果共 14000 字，约 14000 token");
    expect(chinesePage).toContain("后面还有 13000 字，约 13000 token，没有给你");
    expect(chinesePage).toContain("调用 read_connection_result");
  });

  it("is cut where the next character would go over the budget for mixed text", async () => {
    const text = "修复了 GitHub issue #66 的截断。".repeat(500);
    const page = shown(await tokenResult(text, 500).first());
    expect(text.startsWith(page)).toBe(true);
    expect(estimateTokens(page)).toBeLessThanOrEqual(500);
    expect(estimateTokens(text.slice(0, page.length + 1))).toBeGreaterThan(500);
  });

  it("is left whole when the estimate fits the budget, even with more characters than the budget", async () => {
    const text = "x".repeat(3_900);                               // 975 token
    expect(await tokenResult(text, 1_000).first()).toBe(text);
  });

  it("pages through the rest by offset with the same token budget, and keeps max_chars for the whole text", async () => {
    const text = "中文和English混排的结果。".repeat(400);
    const { call, first } = tokenResult(text, 300);
    let page = await first();
    const id = resultIdOf(page);
    expect(id).toBeTruthy();
    let joined = shown(page);
    for (let guard = 0; guard < 100 && !page.includes("已经是结尾"); guard += 1) {
      const offset = Number(/offset=(\d+)。/.exec(page)![1]);
      expect(offset).toBe(joined.length);
      page = await call("read_connection_result", { result_id: id, offset });
      expect(estimateTokens(shown(page))).toBeLessThanOrEqual(300);
      joined += shown(page);
    }
    expect(joined).toBe(text);
    const whole = await call("read_connection_result", { result_id: id, offset: 0, max_chars: text.length });
    expect(shown(whole)).toBe(text);
  });

  it("never cuts a surrogate pair in two", async () => {
    // 每个 emoji 是两个 UTF-16 单元。预算的边界、max_chars 和 offset 都可能落在一对的中间。
    const text = "😀".repeat(2_000) + "𠀀".repeat(500);
    const { call, first } = tokenResult(text, 101);
    const page = await first();
    const firstPart = shown(page);
    expect(firstPart).toBe("😀".repeat(404));
    const id = resultIdOf(page);
    const odd = await call("read_connection_result", { result_id: id, offset: 0, max_chars: 7 });
    expect(shown(odd)).toBe("😀😀😀");
    const tiny = await call("read_connection_result", { result_id: id, offset: 0, max_chars: 1 });
    expect(shown(tiny)).toBe("😀");
    const inside = await call("read_connection_result", { result_id: id, offset: 4_001, max_chars: 4 });
    expect(shown(inside)).toBe("𠀀𠀀");
    for (const part of [firstPart, shown(odd), shown(tiny), shown(inside)]) {
      expect(part).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });
});
