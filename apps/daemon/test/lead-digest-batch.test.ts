// 按批叫醒 Lead 看摘要（Lead 事件主干 spec D3、D5，工单 04 接上 05 的 dueDigestBatch、markEventsDigested）。
// 走完整的落库路径：事件写进库，daemon 按常设指令 events.digest_batch 判断该不该叫醒，叫醒假的 pi 会话
// （fake-pi-session.ts），这一轮成功以后把这一批记成 digested。断言 Lead 收到的当前局面、这一轮的来源、
// 事件的处置、inbox 行的状态和叫醒的次数。场景 3（两张工单同因失败）：合成一件，Lead 只看到一次，写明合并了哪几张工单。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addInbox, createItem, listEvents, listInbox, openDb, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { shortenDigestWait } from "./digest-wait.js";
import { fakePiLead, type FakeCall } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-digest-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(lead: ReturnType<typeof fakePiLead>) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {} });
}

// 瞬时失败的重试说明（engine 的 transient-retry.ts 写的样子）：digest 级；同一个根因码的第二条按根因合并进第一条（05）。
function retryNotice(title: string): { itemId: number; inboxId: number } {
  const itemId = createItem(db, { title, brief: "b", createdBy: "user" });
  const { id } = addInbox(db, {
    itemId, severity: "attention", source: "structural", summary: `工单 #${itemId}：网络中断，30 秒后自动重试`,
    payload: { kind: "transient_retry", runId: itemId * 10, attempt: 1, limit: 5, code: "network_error" }, lossless: true,
  });
  return { itemId, inboxId: id! };
}

const digestCalls = (calls: FakeCall[]) => calls.filter((call) => call.inputs.some((input) => input.includes('kind="digest"')));
const notices = () => listEvents(db, { kind: "inbox.attention" });

describe("the digest batch", () => {
  it("wakes Lead once for the batch, shows the merged tickets once, and marks the batch digested", async () => {
    shortenDigestWait(db, 150);
    const lead = fakePiLead(() => ({ say: "NO_REPLY" }));
    await start(lead);
    const a = retryNotice("迁移 A");
    const b = retryNotice("迁移 B");
    expect(notices().map((event) => event.disposition)).toEqual([null, "superseded"]);

    await vi.waitFor(() => expect(digestCalls(lead.calls)).toHaveLength(1));
    const [call] = digestCalls(lead.calls);
    expect(call!.situation).toContain(`同一个根因（network_error）合并进来 1 件：#${b.itemId}「迁移 B」`);
    expect(call!.situation!.match(/网络中断，30 秒后自动重试/gu)).toHaveLength(1);

    // 这一轮成功以后：第一条记成 digested（摘要编号、依据），合并进来的那条还是 superseded，两行 inbox 都消化掉了。
    await vi.waitFor(() => expect(notices()[0]).toMatchObject({
      disposition: "digested",
      dispositionDetail: { digestId: expect.stringMatching(/^lead-run:/u), standingOrder: { id: "events.digest_batch", version: 2 } },
    }));
    expect(notices()[1]!.disposition).toBe("superseded");
    expect(listInbox(db).filter((row) => [a.inboxId, b.inboxId].includes(row.id)).map((row) => row.state))
      .toEqual(["consumed", "consumed"]);
    // 安静的摘要回合不在会话里留一轮，也不再为这一批叫醒 Lead。
    await pause(300);
    expect(digestCalls(lead.calls)).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM channel_turns WHERE origin_kind = 'system:digest'").get()).toEqual({ n: 0 });
  });

  it("waits for the standing order's wait time before it wakes Lead", async () => {
    shortenDigestWait(db, 600);
    const lead = fakePiLead(() => ({ say: "NO_REPLY" }));
    await start(lead);
    const written = Date.now();
    retryNotice("迁移 A");

    await pause(300);
    expect(digestCalls(lead.calls)).toEqual([]);
    await vi.waitFor(() => expect(digestCalls(lead.calls)).toHaveLength(1), { timeout: 3_000 });
    expect(Date.now() - written).toBeGreaterThanOrEqual(600);
  });

  it("backs off after a failed digest round instead of calling the model on every poll", async () => {
    vi.stubEnv("PLC_LEAD_WAKE_RETRY_MS", "500");
    shortenDigestWait(db, 1);
    let failures = 1;
    const lead = fakePiLead((call) => (call.inputs.some((input) => input.includes('kind="digest"')) && failures-- > 0
      ? { error: '503: {"message":"upstream connect error or disconnect/reset before headers (providers=claude)"}' }
      : { say: "NO_REPLY" }));
    await start(lead);
    retryNotice("迁移 A");

    await vi.waitFor(() => expect(digestCalls(lead.calls)).toHaveLength(1));
    // 失败的这一轮落成一张失败卡片，来源是 system:digest。
    await vi.waitFor(() => expect(db.prepare(
      "SELECT origin_kind, state FROM channel_turns WHERE origin_kind = 'system:digest'",
    ).all()).toEqual([{ origin_kind: "system:digest", state: "failed" }]));
    await pause(250);
    expect(digestCalls(lead.calls)).toHaveLength(1);
    expect(notices()[0]!.disposition).toBeNull();

    // 退避到点：再叫一次，这次成功了，这一批记成 digested。
    await vi.waitFor(() => expect(digestCalls(lead.calls)).toHaveLength(2), { timeout: 3_000 });
    await vi.waitFor(() => expect(notices()[0]!.disposition).toBe("digested"));
  });
});
