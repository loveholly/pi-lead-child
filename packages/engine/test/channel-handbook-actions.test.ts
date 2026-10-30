// 交接说明的操作（操作层的 channel_handbook，issue 06/07）：设置页和 Lead 调同一个函数。
//   - update：你本人改，可以放宽，写一个作者是你的新版本；Lead 用它被拒绝，拿到「去哪里点」。
//   - tighten：Lead 只能收紧（一句改严、关开关），有一项放宽就拒绝；和最新版本一样时不写新版本。
//   - rehearse：没有接任何来源时说明为什么做不了。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CHANNEL_HANDBOOK_DEFAULTS, type ChannelHandbook } from "@pi-lead-child/protocol";
import { channelHandbook, getStandingOrder, listStandingOrderVersions, openDb, type Db } from "@pi-lead-child/store";
import { runUiAction, UiActionError } from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-handbook-actions-"), "plc.db"));
});

afterEach(() => {
  db.close();
});

const target = { type: "channel_handbook", id: "handbook" } as const;
const lead = { kind: "lead", turnId: null } as const;
const withMode = (id: string, mode: ChannelHandbook["situations"][number]["mode"]): ChannelHandbook => ({
  ...CHANNEL_HANDBOOK_DEFAULTS,
  situations: CHANNEL_HANDBOOK_DEFAULTS.situations.map((item) => (item.id === id ? { ...item, mode } : item)),
});

describe("the channel_handbook actions", () => {
  it("you change it directly, loosening included: a new version written by you, in effect at once", async () => {
    await runUiAction(db, { target, action: "update", input: withMode("work_build", "auto"), caller: { kind: "user" } });
    expect(listStandingOrderVersions(db, "channel.handbook").at(-1)).toMatchObject({ version: 2, author: "user" });
    expect(channelHandbook(db)!.handbook.situations.find((item) => item.id === "work_build")!.mode).toBe("auto");
  });

  it("Lead cannot use update: it gets a refusal that says where you click", async () => {
    await expect(runUiAction(db, { target, action: "update", input: withMode("work_build", "auto"), reason: "测试", caller: lead }))
      .rejects.toMatchObject({ code: "user_direct", refusal: { where: "设置 → 消息通道 → 自动代你处理" } });
  });

  it("Lead can tighten, and is refused as soon as one item loosens", async () => {
    await runUiAction(db, { target, action: "tighten", input: withMode("work_review", "review"), reason: "用户说 review 先给他看", caller: lead });
    expect(getStandingOrder(db, "channel.handbook")).toMatchObject({ version: 2, author: "lead" });
    expect(channelHandbook(db)!.handbook.situations.find((item) => item.id === "work_review")!.mode).toBe("review");
    const refused = runUiAction(db, { target, action: "tighten", input: withMode("work_build", "auto"), reason: "测试", caller: lead });
    await expect(refused).rejects.toBeInstanceOf(UiActionError);
    await expect(refused).rejects.toMatchObject({ code: "user_direct" });
    expect(getStandingOrder(db, "channel.handbook")!.version).toBe(2);
  });

  it("writes nothing when the handbook is the same as the latest version, and refuses a broken one", async () => {
    const same = await runUiAction(db, { target, action: "tighten", input: CHANNEL_HANDBOOK_DEFAULTS, reason: "测试", caller: lead });
    expect(same.result).toMatchObject({ unchanged: true });
    const noFallback = { ...CHANNEL_HANDBOOK_DEFAULTS, situations: CHANNEL_HANDBOOK_DEFAULTS.situations.filter((item) => item.id !== "other") };
    await expect(runUiAction(db, { target, action: "update", input: noFallback, caller: { kind: "user" } }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(listStandingOrderVersions(db, "channel.handbook")).toHaveLength(1);
  });

  it("says why it cannot rehearse when no source is connected", async () => {
    await expect(runUiAction(db, { target, action: "rehearse", input: { text: "帮我处理一下 PROJ-6651", sender: "colleague" }, reason: "用户让我试一下这句话", caller: lead }))
      .rejects.toMatchObject({ code: "unavailable" });
  });
});
