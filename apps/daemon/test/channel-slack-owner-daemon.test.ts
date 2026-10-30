// 用户发给自己的 Slack 私信在 daemon 里走一遍（用户 2026-10-30：「直接交给 Lead，并且只要确认是我本人，就跟 companion 的权限
// 保持一致，因为是我本人在发消息，只是 reply 要遵循 slack 的语法规范而已」）：
//   Slack 推来用户本人在自己的私信里写的话 → daemon 用这个账号的凭证（kind companion、Companion 的 scope）开用户本人的一轮 →
//   Lead 在这一轮里有用户本人的权限（isLiveUserTurn）→ 回复换成 mrkdwn 发回那条私信 → 推回来的回复和重投的消息不再开一轮。
//   用户在设备列表里撤销这张凭证以后，这个入口的话不再交给 Lead。
// daemon、网关、store、通道 hub、Slack 来源插件都是真的；Slack 和 Lead 的会话是替身。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { isLiveUserTurn } from "@pi-lead-child/engine";
import { FakeSlack } from "@pi-lead-child/engine/testing";
import { DEFAULT_SCOPES, openDb, revokeBinding, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-slack-owner-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

const turnsFromSlack = () => db.prepare(
  "SELECT id, origin_kind, origin_binding_id, state, user_text FROM channel_turns WHERE origin_kind = 'paired:slack' ORDER BY created_at",
).all() as Array<{ id: string; origin_kind: string; origin_binding_id: number; state: string; user_text: string }>;

describe("the user's own Slack DM to themself in the daemon", () => {
  it("opens the user's own turn with Companion's permissions and replies in mrkdwn to the same DM", async () => {
    const slack = new FakeSlack();
    const liveUserTurn: boolean[] = [];
    const lead = fakePiLead(async (call) => {
      const turnId = lead.deps().currentTurnId?.() ?? null;
      liveUserTurn.push(isLiveUserTurn(db, turnId, "approvals:respond"));
      return { say: call.inputs.join("\n").includes("今天要发布吗") ? "## 结论\n**今天不发布**，见 [日历](https://cal.test/x)。" : "好的。" };
    });
    daemon = await startDaemon({
      dataDir: dir, dbPath, log: () => {}, notifyDesktop: () => {}, triageShadow: false,
      sessionFactory: lead.factory as never,
      channels: {
        sources: { slack: { api: slack.api } },
        credentials: { credential: async (provider) => (provider === "slack" ? slack.credential : null) },
      },
    });

    const delivery = slack.selfReply("D0SELF", "今天要发布吗？");
    const received = await daemon.channels!.receive("slack", delivery);
    expect(received.items).toMatchObject([{ role: "owner", handedTo: "owner" }]);

    // 回复换成 mrkdwn，署上 Lead 的名字，发回那条私信。
    await vi.waitFor(() => expect(slack.sent("D0SELF")).toHaveLength(1), { timeout: 10_000 });
    expect(slack.sent("D0SELF")[0]!.text).toMatch(/^.+ \(Assistant\)\n\*结论\*\n\*今天不发布\*，见 <https:\/\/cal\.test\/x\|日历>。$/u);

    // 这一轮是用户本人的一轮：凭证是这个 Slack 账号的，权限和 Companion 一样，Lead 在这一轮里有用户本人的权限。
    const [turn] = turnsFromSlack();
    expect(turn).toMatchObject({ state: "completed", user_text: "今天要发布吗？" });
    const binding = db.prepare("SELECT kind, origin, external_subject, scopes, token_hash, status FROM bindings WHERE id = ?")
      .get(turn!.origin_binding_id) as Record<string, unknown>;
    expect(binding).toMatchObject({ kind: "companion", origin: "channel_owner", external_subject: "slack:U0SELF", token_hash: null, status: "active" });
    expect(JSON.parse(binding.scopes as string)).toEqual(DEFAULT_SCOPES);
    expect(liveUserTurn).toEqual([true]);
    // Lead 看到的是用户本人的话，带着「回复会发回 Slack」的说明，不是外部标签里的原文。
    const input = lead.calls[0]!.inputs.join("\n");
    expect(input).toContain('channel="paired:slack"');
    expect(input).toContain("发给自己的私信");
    expect(input).not.toContain("untrusted_external_text");

    // 推回来的回复、重投的同一条消息：不再开一轮。
    await daemon.channels!.receive("slack", slack.echoOf(slack.sent("D0SELF")[0]!));
    await daemon.channels!.receive("slack", slack.redeliver(delivery));
    expect(turnsFromSlack()).toHaveLength(1);
    expect(lead.calls).toHaveLength(1);

    // 用户在设备列表里撤销了这张凭证：这个入口的话不再交给 Lead，也不会自己恢复。
    revokeBinding(db, turn!.origin_binding_id);
    const after = await daemon.channels!.receive("slack", slack.selfReply("D0SELF", "再问一句"));
    expect(after.items).toMatchObject([{ role: "self_reply" }]);
    expect(turnsFromSlack()).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM bindings WHERE origin = 'channel_owner'").get()).toEqual({ n: 1 });
  }, 30_000);
});
