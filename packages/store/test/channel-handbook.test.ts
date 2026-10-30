// 交接说明（自动代你处理方案 B，.scratch/auto-handling-handbook/issues/01-handbook-data.md）：缺省内容、改动的档位、
// 放开只算可信的版本，和从旧授权表的迁移（全新的库、旧库、重新打开）。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  CHANNEL_AUTHORITY_DEFAULTS, CHANNEL_HANDBOOK_DEFAULTS, channelHandbookProblems, classifyStandingOrderChange, HANDBOOK_FALLBACK_ID,
  handbookFromAuthority, handbookModeCovers, handbookSentence, handbookText, situationIntent, validateStandingOrderDefinition, validStandingOrderRuleParams,
  type ChannelHandbook, type HandbookSituation, type StandingOrderState,
} from "@pi-lead-child/protocol";
import {
  channelHandbook, CHANNEL_HANDBOOK_ORDER_ID, getStandingOrder, listStandingOrderVersions, openDb, recordStandingOrderVersion,
  SYSTEM_STANDING_ORDERS, type Db,
} from "../src/index.js";

const copy = (): ChannelHandbook => structuredClone(CHANNEL_HANDBOOK_DEFAULTS);
const situation = (handbook: ChannelHandbook, id: string): HandbookSituation => handbook.situations.find((item) => item.id === id)!;
const withSituation = (handbook: ChannelHandbook, id: string, patch: Partial<HandbookSituation>): ChannelHandbook => ({
  ...handbook, situations: handbook.situations.map((item) => (item.id === id ? { ...item, ...patch } : item)),
});

const seed = SYSTEM_STANDING_ORDERS.find((order) => order.id === CHANNEL_HANDBOOK_ORDER_ID)!;
const seedState = (): StandingOrderState => {
  const { seedRevision: _revision, status, ...definition } = structuredClone(seed);
  return { ...definition, status: status ?? "active" };
};
const withHandbook = (handbook: ChannelHandbook): StandingOrderState =>
  ({ ...seedState(), action: { type: "rule", rule: "channel.handbook", params: handbook as unknown as Record<string, unknown> }, reason: "测试" });
const tier = (handbook: ChannelHandbook) => classifyStandingOrderChange({ active: [seedState()], before: seedState(), after: withHandbook(handbook) }).tier;

describe("the default handbook", () => {
  it("is a valid standing order with the fallback sentence", () => {
    expect(channelHandbookProblems(CHANNEL_HANDBOOK_DEFAULTS)).toEqual([]);
    expect(validateStandingOrderDefinition(seed)).toEqual([]);
    expect(validStandingOrderRuleParams("channel.handbook", CHANNEL_HANDBOOK_DEFAULTS)).toBe(true);
    // 兜底的一句：Lead 自己判断（和 2026-10-29 起的行为一样）。
    expect(handbookSentence(situation(CHANNEL_HANDBOOK_DEFAULTS, HANDBOOK_FALLBACK_ID))).toBe("上面都不像的，你自己判断，拿不准再问我。");
  });

  // 2026-10-29 的起因：「帮我处理一下这个 ticket：PROJ-6651」落进「别的」，按授权表只能问你。交接说明里有一句接住它。
  it("lets the user hand off a fix request", () => {
    const fix = situation(CHANNEL_HANDBOOK_DEFAULTS, "work_fix");
    expect(fix.mode).toBe("auto");
    expect(fix.abilities).toContain("coding_ticket");
    expect(handbookSentence(fix)).toBe("有人请我排查或修复问题，比如「帮我处理一下 PROJ-6651」，你直接处理，做完回他。");
    expect(handbookSentence(situation(CHANNEL_HANDBOOK_DEFAULTS, "closing"))).toBe("道谢或者告别，比如「谢谢，问题解决了」，你回个表情或者道声谢。");
  });

  it("names the assistant with the user's name, not a fixed one", () => {
    expect(handbookText("给 {lead} 的交接说明", "小白")).toBe("给 小白 的交接说明");
  });

  it("rejects a handbook without the fallback, with repeated ids, or with a loose customer cap", () => {
    const noFallback = { ...copy(), situations: copy().situations.filter((item) => item.id !== HANDBOOK_FALLBACK_ID) };
    expect(channelHandbookProblems(noFallback)).toEqual([`缺少兜底的一句（${HANDBOOK_FALLBACK_ID}）`]);
    const repeated = { ...copy(), situations: [...copy().situations, situation(copy(), "chat")] };
    expect(channelHandbookProblems(repeated)).toEqual(["编号重复：chat"]);
    const customer = { ...copy(), caps: { ...copy().caps, customer: "auto" as const } };
    expect(channelHandbookProblems(customer)).toEqual(["客户的上限最宽只能到「交给你」"]);
    expect(validStandingOrderRuleParams("channel.handbook", customer)).toBe(false);
    expect(validateStandingOrderDefinition(withHandbook(customer))).toContain("客户的上限最宽只能到「交给你」");
  });
});

describe("comparing modes", () => {
  it("counts sending and working as two separate powers", () => {
    expect(handbookModeCovers("auto", "review")).toBe(true);
    expect(handbookModeCovers("review", "auto")).toBe(false);
    // 婉拒会发一句话，做好给你看会去查：谁也不比谁宽。
    expect(handbookModeCovers("review", "refuse")).toBe(false);
    expect(handbookModeCovers("refuse", "review")).toBe(false);
    expect(handbookModeCovers("hand", "tell")).toBe(true);
    expect(handbookModeCovers("tell", "hand")).toBe(true);
  });
});

describe("changing the handbook", () => {
  it("lets Lead tighten a sentence, a cap, or turn the switch off", () => {
    expect(tier(withSituation(copy(), "work_fix", { mode: "review" }))).toBe("conservative");
    expect(tier({ ...copy(), caps: { ...copy().caps, external: "tell" } })).toBe("conservative");
    expect(tier({ ...copy(), autoReply: false })).toBe("conservative");
    expect(tier(withSituation(copy(), "work_fix", { section: "mine" }))).toBe("conservative");
  });

  it("needs the user for anything looser", () => {
    expect(tier(withSituation(copy(), "work_build", { mode: "auto" }))).toBe("permissive");
    expect(tier(withSituation(copy(), "ask_tech", { abilities: ["read_code", "coding_ticket"] }))).toBe("permissive");
    expect(tier({ ...copy(), caps: { ...copy().caps, unknown: "review" } })).toBe("permissive");
    expect(tier(withSituation(copy(), "work_build", { exception: { text: "小改动", mode: "auto" } }))).toBe("permissive");
  });

  it("treats a new wording as unknown: it changes which messages land on the sentence", () => {
    expect(tier(withSituation(copy(), "work_fix", { text: "有人请我做任何事" }))).toBe("permissive");
  });

  it("compares an added sentence with the fallback, and a removed one with where its messages go", () => {
    const quiet: HandbookSituation = { id: "logs", section: "mine", text: "有人请我看线上日志", mode: "hand", abilities: [] };
    expect(tier({ ...copy(), situations: [...copy().situations, quiet] })).toBe("conservative");
    expect(tier({ ...copy(), situations: [...copy().situations, { ...quiet, mode: "auto", abilities: ["read_connections"] }] })).toBe("permissive");
    // 删掉「闲聊」（只告诉你）：闲聊落到兜底（自己判断，放手），比原来放开。
    expect(tier({ ...copy(), situations: copy().situations.filter((item) => item.id !== "chat") })).toBe("permissive");
    // 删掉「实现需求」（交给你）以前，先把兜底收紧成交给你：两者一样，不算放开。
    const strictFallback = withSituation(copy(), HANDBOOK_FALLBACK_ID, { mode: "hand", autoPhrase: undefined });
    expect(classifyStandingOrderChange({
      active: [withHandbook(strictFallback)], before: withHandbook(strictFallback),
      after: withHandbook({ ...strictFallback, situations: strictFallback.situations.filter((item) => item.id !== "work_build") }),
    }).tier).toBe("conservative");
  });
});

describe("the old intent behind a sentence", () => {
  // 过渡用：授权表和信心模型还按旧意图读。缺省的句子每句都有明确的对应，要你本人决定或做事的算 other（不算查资料）。
  it("maps every default sentence explicitly, and the user's own sentences by their abilities", () => {
    expect(Object.fromEntries(CHANNEL_HANDBOOK_DEFAULTS.situations.map((item) => [item.id, situationIntent(item)]))).toEqual({
      ask_tech: "knowledge", ask_progress: "progress", ask_metrics: "knowledge", ask_requirement: "knowledge",
      discuss_tech: "other", discuss_design: "other",
      work_review: "code_review", work_approve: "approve", work_fix: "other", work_build: "other", work_summary: "other",
      notice: "meeting", chat: "other", closing: "closing", other: "other",
    });
    expect(situationIntent({ id: "logs", abilities: ["read_connections"] })).toBe("knowledge");
    expect(situationIntent({ id: "merge_bot", abilities: ["read_code", "approve"] })).toBe("approve");
    expect(situationIntent({ id: "hotfix", abilities: ["read_code", "coding_ticket"] })).toBe("other");
    expect(situationIntent({ id: "ping", abilities: [] })).toBe("other");
  });
});

describe("migrating from the authority table", () => {
  it("keeps the defaults when the user never changed the table", () => {
    expect(handbookFromAuthority(CHANNEL_AUTHORITY_DEFAULTS, CHANNEL_AUTHORITY_DEFAULTS, true)).toEqual(CHANNEL_HANDBOOK_DEFAULTS);
  });

  it("moves the user's changes onto the matching sentences", () => {
    const table = { ...CHANNEL_AUTHORITY_DEFAULTS, approve: { action: "ask" as const }, knowledge: { action: "remind" as const } };
    const migrated = handbookFromAuthority(table, CHANNEL_AUTHORITY_DEFAULTS, false);
    expect(migrated.autoReply).toBe(false);
    // 旧表收紧了 approve：例外「CI 过了直接处理」不能比新的做法放开，去掉。
    expect(situation(migrated, "work_approve")).toMatchObject({ mode: "hand" });
    expect(situation(migrated, "work_approve").exception).toBeUndefined();
    expect(situation(migrated, "ask_tech").mode).toBe("tell");
    expect(situation(migrated, "ask_requirement").mode).toBe("tell");
    expect(situation(migrated, "work_fix")).toEqual(situation(CHANNEL_HANDBOOK_DEFAULTS, "work_fix"));
    expect(channelHandbookProblems(migrated)).toEqual([]);
  });
});

const handbookVersion = (db: Db, handbook: ChannelHandbook, author: "lead" | "user", approvedBy: string | null = null) =>
  recordStandingOrderVersion(db, withHandbook(handbook), { author, approvedBy });

describe("reading the handbook from the store", () => {
  it("seeds a fresh database with the defaults and writes no migration", () => {
    const db = openDb(join(tempDir("plc-handbook-fresh-"), "plc.db"));
    const versions = listStandingOrderVersions(db, CHANNEL_HANDBOOK_ORDER_ID);
    expect(versions.map((version) => [version.version, version.author])).toEqual([[1, "system"]]);
    expect(channelHandbook(db)?.handbook).toEqual(CHANNEL_HANDBOOK_DEFAULTS);
  });

  it("does not count Lead's loosening, but counts its tightening", () => {
    const db = openDb(join(tempDir("plc-handbook-trust-"), "plc.db"));
    // 「实现需求」缺省就有改代码的能力（issue 04）；Lead 再加上批准、把做法放开，这两项都不算数。
    let next = withSituation(copy(), "work_build", { mode: "auto", abilities: ["read_code", "coding_ticket", "approve"] });
    next = withSituation(next, "ask_tech", { mode: "review" });
    next = { ...next, caps: { ...next.caps, unknown: "auto" }, situations: [...next.situations,
      { id: "logs", section: "mine", text: "有人请我看线上日志", mode: "auto", abilities: ["read_connections"] }] };
    handbookVersion(db, next, "lead");
    const policy = channelHandbook(db)!;
    expect(policy.requested).toEqual(next);
    expect(situation(policy.handbook, "work_build")).toMatchObject({ mode: "hand", abilities: ["read_code", "coding_ticket"] });
    expect(situation(policy.handbook, "ask_tech").mode).toBe("review");
    // 新加的一句和兜底的一句比：兜底是放手，做法算数；能力兜底没有，去掉。
    expect(situation(policy.handbook, "logs")).toMatchObject({ mode: "auto", abilities: [] });
    expect(policy.handbook.caps.unknown).toBe("tell");
  });

  it("counts loosening the user wrote or approved", () => {
    const db = openDb(join(tempDir("plc-handbook-user-"), "plc.db"));
    const next = withSituation(copy(), "work_build", { mode: "auto" });
    handbookVersion(db, next, "lead", "user");
    expect(situation(channelHandbook(db)!.handbook, "work_build").mode).toBe("auto");
  });

  it("does not let a reworded sentence keep the old sentence's mode", () => {
    const db = openDb(join(tempDir("plc-handbook-reword-"), "plc.db"));
    handbookVersion(db, withSituation(copy(), "work_fix", { text: "有人请我做任何事" }), "lead");
    // 按新加的一句算，和兜底比：改代码的能力兜底没有，去掉。
    expect(situation(channelHandbook(db)!.handbook, "work_fix")).toMatchObject({ mode: "auto", abilities: [] });
  });
});

describe("migrating an existing database", () => {
  // 旧库：授权表被用户改过（approve 改成问你），还没有交接说明。
  const legacyDb = (): string => {
    const path = join(tempDir("plc-handbook-legacy-"), "plc.db");
    const db = openDb(path);
    const authority = getStandingOrder(db, "channel.authority")!;
    if (authority.action.type !== "rule") throw new Error("channel.authority");
    const { version: _v, author: _a, approvedBy: _b, status: _s, createdAt: _c, seedRevision: _r, ...definition } = authority;
    recordStandingOrderVersion(db, {
      ...definition, reason: "用户改了授权表",
      action: { ...authority.action, params: { ...authority.action.params, intents: { ...CHANNEL_AUTHORITY_DEFAULTS, approve: { action: "ask" } } } },
    }, { author: "user" });
    // 交接说明上线以前的库里没有这条指令。表只能追加（schema.ts 的触发器），模拟旧库时先去掉触发器；openDb 会再建上。
    db.exec("DROP TRIGGER standing_orders_append_only_delete");
    db.prepare("DELETE FROM standing_orders WHERE order_id = ?").run(CHANNEL_HANDBOOK_ORDER_ID);
    db.close();
    return path;
  };

  it("carries the user's changes over once, and reopening writes nothing more", () => {
    const path = legacyDb();
    const db = openDb(path);
    const versions = listStandingOrderVersions(db, CHANNEL_HANDBOOK_ORDER_ID);
    expect(versions.map((version) => [version.version, version.author])).toEqual([[1, "system"], [2, "user"]]);
    expect(situation(channelHandbook(db)!.handbook, "work_approve")).toMatchObject({ mode: "hand" });
    expect(situation(channelHandbook(db)!.handbook, "work_fix").mode).toBe("auto");
    db.close();
    const reopened = openDb(path);
    expect(listStandingOrderVersions(reopened, CHANNEL_HANDBOOK_ORDER_ID)).toHaveLength(2);
  });

  it("leaves a handbook the user already changed alone", () => {
    const path = legacyDb();
    const db = openDb(path);
    handbookVersion(db, withSituation(copy(), "work_approve", { mode: "auto" }), "user");
    db.close();
    const reopened = openDb(path);
    expect(listStandingOrderVersions(reopened, CHANNEL_HANDBOOK_ORDER_ID)).toHaveLength(3);
    expect(situation(channelHandbook(reopened)!.handbook, "work_approve").mode).toBe("auto");
  });
});
