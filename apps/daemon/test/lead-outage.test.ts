// 一次停摆，一张卡片（2026-10-16）。Lead 不能工作时，系统把积压的事汇总给用户（Jarvis 模式的兜底）。
// 以前每次汇总都是一条新的「系统通知」，正文把 Lead 写给自己的跟进原样转给用户（工具名、给 Lead 的指令）。
// 现在一次停摆只有一条系统通知：开头一行说什么时候起、为什么、积压了几件、恢复了没有，下面每件一行，写给用户看。
// 停摆期间来了新的事，这一条原地更新；恢复以后再更新一次，写上恢复的时间。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addInbox, addLeadFollowUp, createItem, openDb, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-outage-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_NETWORK_RETRY_MS", "40");
  vi.stubEnv("PLC_LEAD_DOWN_GRACE_MS", "60");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

function quietLead() {
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(message: string) {
        prompts.push(message);
        for (const listener of listeners) {
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "NO_REPLY" } });
          listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "NO_REPLY" }] } });
        }
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  return { factory, prompts };
}

const outageTurns = () => db.prepare(
  "SELECT id, assistant_text FROM channel_turns WHERE origin_kind = 'system:fallback-notice' ORDER BY created_at",
).all() as Array<{ id: string; assistant_text: string }>;

describe("while Lead cannot work", () => {
  it("keeps one outage notice, written for the user, updated in place until Lead is back", async () => {
    let down: string | null = "getaddrinfo ENOTFOUND api.anthropic.com";
    const lead = quietLead();
    daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, networkProbe: async () => down,
    });
    const review = createItem(db, { title: "E2E 终验", brief: "b", createdBy: "user" });
    addLeadFollowUp(db, {
      at: new Date(Date.now() - 1_000), itemId: review,
      note: "看 #66 reviewer Run #87 恢复了没有；如果用户不在，用 notify_user（batchable）推送，再 record_disposition。",
    });
    const migration = createItem(db, { title: "迁移脚本", brief: "b", createdBy: "user" });
    addInbox(db, { itemId: migration, severity: "blocker", source: "structural", summary: `工单 #${migration} 执行重试已耗尽（执行失败 2/2）` });

    await vi.waitFor(() => expect(outageTurns()).toHaveLength(1));
    const [first] = outageTurns();
    const [headline, ...lines] = first!.assistant_text.split("\n");
    expect(headline).toMatch(/^Paimon 离线 \d\d:\d\d 起（网络中断）· 期间积压 2 件$/);
    expect(lines.join("\n")).toContain(`工单 #${review}「E2E 终验」：Paimon 设的一次跟进到点了`);
    expect(lines.join("\n")).toContain(`工单 #${migration}「迁移脚本」：执行重试已耗尽（执行失败 2/2）`);
    expect(first!.assistant_text).not.toMatch(/notify_user|record_disposition|batchable|跟进：看/);
    expect(lead.prompts).toEqual([]);

    // 停摆期间又来了一件：还是这一条，原地更新。
    const report = createItem(db, { title: "周报", brief: "b", createdBy: "user" });
    addInbox(db, { itemId: report, severity: "blocker", source: "structural", summary: `工单 #${report} 需要你确认发布时间` });
    await vi.waitFor(() => expect(outageTurns()[0]!.assistant_text).toMatch(/期间积压 3 件/));
    expect(outageTurns()).toHaveLength(1);
    expect(outageTurns()[0]!.id).toBe(first!.id);

    // 网络恢复：Lead 接着处理积压的事，这一条写上恢复的时间。
    down = null;
    await vi.waitFor(() => expect(outageTurns()[0]!.assistant_text.split("\n")[0])
      // 测试里的停摆通常不到一分钟：同一分钟里开始又恢复时写「不到一分钟」，不写「19:11–19:11」。
      .toMatch(/^Paimon 离线 \d\d:\d\d(?:–\d\d:\d\d|，不到一分钟)（网络中断）· 期间积压 3 件 · (?:\d\d:\d\d )?已恢复并补处理$/));
    expect(outageTurns()).toHaveLength(1);
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("执行重试已耗尽"))).toBe(true));
  });
});
