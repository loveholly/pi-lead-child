// 发布评审：Lead 聊天里同一次故障出现了重叠的卡片（19:12–21:09 和 19:19–08:30），还有时长为零的「02:46–02:46」。
// 一次停摆只能有一张卡片，时间段要对：
//   · 新的一次停摆不能从上一次停摆恢复之前开始（不重叠）；
//   · daemon 在停摆中途重启时，接着更新还没结束的那一张，不另开一张，也不让它永远停在「起」。
// 停摆卡片的记录就是会话里那条系统通知（id 是 turn_outage_<开始的毫秒>），daemon 重启后从它读回。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTurn, appendAssistantDelta, completeTurn, openDb, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { outageStart, outageStep, restoreOutages } from "../src/lead-outage.js";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-outage-ledger-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

function outageNotice(since: number, text: string, at: Date): string {
  const turn = createTurn(db, { id: `turn_outage_${since}`, originKind: "system:fallback-notice", userText: "", state: "streaming", now: at });
  appendAssistantDelta(db, turn.id, text, at);
  completeTurn(db, turn.id, at);
  return turn.id;
}

describe("when a new outage starts", () => {
  it("never starts before the previous outage ended", () => {
    const ended = Date.parse("2026-10-16T13:09:00.000Z");
    expect(outageStart(Date.parse("2026-10-16T11:19:00.000Z"), ended)).toBe(ended);
    expect(outageStart(Date.parse("2026-10-16T14:00:00.000Z"), ended)).toBe(Date.parse("2026-10-16T14:00:00.000Z"));
    expect(outageStart(Date.parse("2026-10-16T11:19:00.000Z"), null)).toBe(Date.parse("2026-10-16T11:19:00.000Z"));
  });
});

// 每一拍轮询对停摆卡片做什么。发布评审 reliability-backlog 复核：判断 Lead 能不能工作的那一步出错时，
// 结果被当成「能工作」（null），停摆可能被当成已经结束、卡片被收尾。出错（undefined）时这一拍不动卡片。
describe("what a poller tick does with the outage card", () => {
  const base = { now: 10 * 60_000, daemonStartedAt: 0, graceMs: 60_000, leadOnline: () => true };
  const incapacity = { reason: "网络中断", kind: "network" as const, since: 0 };

  it("leaves an open outage alone when it could not tell whether Lead can work", () => {
    expect(outageStep({ ...base, incapacity: undefined, outage: { restored: undefined } })).toBe("none");
    expect(outageStep({ ...base, incapacity: undefined, outage: { restored: true } })).toBe("none");
  });

  it("summarizes the backlog while Lead cannot work", () => {
    expect(outageStep({ ...base, incapacity, outage: null })).toBe("summarize");
    expect(outageStep({ ...base, incapacity, outage: { restored: undefined } })).toBe("summarize");
  });

  it("closes the open outage once Lead works again, and a restored one only after the grace period", () => {
    expect(outageStep({ ...base, incapacity: null, outage: { restored: undefined } })).toBe("close");
    expect(outageStep({ ...base, incapacity: null, outage: { restored: true } })).toBe("close");
    expect(outageStep({ ...base, now: 30_000, incapacity: null, outage: { restored: true } })).toBe("none");
    expect(outageStep({ ...base, incapacity: null, outage: { restored: undefined }, leadOnline: () => false })).toBe("none");
    expect(outageStep({ ...base, incapacity: null, outage: null })).toBe("none");
  });
});

describe("after a daemon restart", () => {
  it("reads back the outage that was still open, with its items, and when the last one ended", () => {
    const closedSince = Date.parse("2026-10-16T10:00:00.000Z");
    outageNotice(closedSince, "Lead 离线 18:00–18:20（模型服务连不上）· 期间积压 1 件 · 18:20 已恢复并补处理\n· 工单 #3「周报」：需要你确认 —— 已交给 Lead",
      new Date("2026-10-16T10:20:00.000Z"));
    const openSince = Date.parse("2026-10-16T11:12:00.000Z");
    const openId = outageNotice(openSince,
      "Lead 离线 19:12 起（网络中断）· 期间积压 2 件\n· 工单 #7「迁移脚本」：执行重试已耗尽 —— 等 Lead 恢复后处理\n· 提醒：交周报 —— 已推送给你",
      new Date("2026-10-16T11:13:00.000Z"));

    const restored = restoreOutages(db);
    expect(restored.lastEndedAt).toBe(Date.parse("2026-10-16T10:20:00.000Z"));
    expect(restored.open).toEqual({
      since: openSince, kind: "network", turnId: openId,
      items: [
        { line: "工单 #7「迁移脚本」：执行重试已耗尽", kind: "inbox", hasRecord: false },
        { line: "提醒：交周报", kind: "pushed", hasRecord: false },
      ],
    });
  });

  // 发布评审 reliability-backlog：没结束的卡片比一张已经结束的卡片还早，说明之后又有一次停摆开始并结束了。
  // 以前照样把它当成「还没结束的那一次」接着更新，新的停摆写进一张旧卡片。
  it("does not reopen an open card that is older than a card that already ended", () => {
    const staleSince = Date.parse("2026-10-16T09:00:00.000Z");
    outageNotice(staleSince, "Lead 离线 17:00 起（网络中断）· 期间积压 1 件\n· 工单 #2「旧事」：执行重试已耗尽 —— 等 Lead 恢复后处理",
      new Date("2026-10-16T09:01:00.000Z"));
    const closedSince = Date.parse("2026-10-16T10:00:00.000Z");
    outageNotice(closedSince, "Lead 离线 18:00–18:20（模型服务连不上）· 期间积压 1 件 · 18:20 已恢复并补处理\n· 工单 #3「周报」：需要你确认 —— 已交给 Lead",
      new Date("2026-10-16T10:20:00.000Z"));

    const restored = restoreOutages(db);
    expect(restored.open).toBeNull();
    expect(restored.lastEndedAt).toBe(Date.parse("2026-10-16T10:20:00.000Z"));
  });

  it("finishes the open outage card with an end time instead of leaving it open forever", async () => {
    vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
    vi.stubEnv("PLC_LEAD_DOWN_GRACE_MS", "60");
    const openSince = Date.now() - 10 * 60_000;
    outageNotice(openSince, "Lead 离线 19:12 起（网络中断）· 期间积压 1 件\n· 工单 #7「迁移脚本」：执行重试已耗尽 —— 等 Lead 恢复后处理",
      new Date(openSince + 60_000));
    daemon = await startDaemon({
      dataDir: dir, dbPath, log: () => {},
      sessionFactory: (async () => ({
        modelName: "stub/model",
        session: { sessionId: "s", subscribe() { return () => {}; }, async prompt() {}, async steer() {}, async followUp() {}, dispose() {} },
      })) as never,
    });
    const card = () => db.prepare("SELECT assistant_text FROM channel_turns WHERE id=?").get(`turn_outage_${openSince}`) as
      { assistant_text: string };
    await vi.waitFor(() => expect(card().assistant_text.split("\n")[0]).toMatch(/^Paimon 离线 \d\d:\d\d–\d\d:\d\d（网络中断）/));
    expect(card().assistant_text).toContain("工单 #7「迁移脚本」：执行重试已耗尽");
    expect(db.prepare("SELECT COUNT(*) AS n FROM channel_turns WHERE id LIKE 'turn_outage_%'").get()).toEqual({ n: 1 });
  });
});
