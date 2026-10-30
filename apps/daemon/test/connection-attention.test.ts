// 连接要用户处理时交给 Lead 的说明和等待（connection-attention.ts）。
//   · 授权失效：说明带着要用户做的事，并登记等待；用户重新授权（状态变回 connected）时等待了结，叫醒 Lead（工单 #98）。
//   · 授权快到期：只交说明，不登记等待（2026-10-19 审查）。这时状态还是 connected，用户重新授权以后状态不变，
//     等待了结不了，24 小时后会误报「没等到」。
//   · 说明和等待落在同一毫秒时（2026-10-20 的 verify 里时过时不过），这条说明也不能把了结降成只记一笔：
//     它说的是授权失效，不是用户重新授权了（store 的 lead-waits.ts 的 coveringEvent）。
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { insertConnection, listEvents, listInbox, listOpenLeadWaits, openDb, updateConnection } from "@pi-lead-child/store";
import { recordConnectionAttention } from "../src/connection-attention.js";

const fresh = () => openDb(join(tempDir("plc-connection-attention-"), "plc.db"));

afterEach(() => {
  vi.useRealTimers();
});

describe("a connection that needs the user", () => {
  it("waits for a re-authorization when the grant is gone, and wakes Lead once the user is done", () => {
    const db = fresh();
    const row = insertConnection(db, { provider: "github", label: "GitHub", serverUrl: "https://api.githubcopilot.com/mcp/", tokenSource: "gh_cli" });
    updateConnection(db, row.id, { status: "needs_reauth", failure_kind: "invalid_grant" });
    // 时钟固定（只换 Date）：说明和等待落在同一毫秒，以前这时等待的了结只记一笔。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-20T08:00:00.000Z"));
    recordConnectionAttention(db, { kind: "needs_reauth", key: "github", label: "GitHub", message: "GitHub 的授权失效了" }, () => {});

    const [note] = listInbox(db, {});
    expect(JSON.parse(note!.payload)).toMatchObject({
      kind: "connection_attention", userAction: { kind: "reauthorize", target: "connection:github" },
    });
    expect(listOpenLeadWaits(db)).toMatchObject([{ entityKey: "connection:github", origin: "system:connection_attention" }]);

    // 一分钟后用户重新授权，Lead 还没处理那条说明。
    vi.setSystemTime(Date.parse("2026-10-20T08:01:00.000Z"));
    updateConnection(db, row.id, { status: "connected" });
    expect(listOpenLeadWaits(db)).toEqual([]);
    expect(listEvents(db, { kind: "lead.wait_satisfied" })).toMatchObject([{ level: "tell", entityKey: "connection:github" }]);
    db.close();
  });

  it("only tells Lead when the grant is about to expire, without a wait that could never end", () => {
    const db = fresh();
    insertConnection(db, { provider: "github", label: "GitHub", serverUrl: "https://api.githubcopilot.com/mcp/", tokenSource: "oauth" });
    recordConnectionAttention(db, { kind: "expiring", key: "github", label: "GitHub", message: "GitHub 的授权 3 天后到期" }, () => {});
    expect(JSON.parse(listInbox(db, {})[0]!.payload)).toMatchObject({ attention: "expiring", userAction: { kind: "reauthorize" } });
    expect(listOpenLeadWaits(db)).toEqual([]);
    db.close();
  });
});
