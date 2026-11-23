// A colleague's one-to-one DM that needs no reply still shows up as a card (user 2026-11-23). Before, the authority table's
// "needs no reply: record only" branch marked such a DM no_action and opened no card, so two ordinary notices from a colleague
// never appeared in the conversation. Now the DM gets a quiet card: it is not pushed, Lead is not woken, nothing is sent for
// the user, and further messages in the same DM join that one card. Group chats, channels, bots and an explicit record-only
// delivery rule keep their old behaviour. Real SQLite, the real Slack source, fake Slack, a scripted SmartModel, Lead connected
// as in the daemon. All people and words are made up.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import {
  getEvent, getStandingOrder, listChannelCardsForObject, listEvents, openDb, updateStandingOrderByUser, type Db,
} from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter, type SmartModel } from "../src/index.js";
import { FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let pushes: Array<{ cardId: number }>;
let intakes: number;
const hubs: ChannelHub[] = [];
const clock = new Date("2026-11-23T03:00:00.000Z");

beforeEach(() => {
  db = openDb(join(tempDir("plc-direct-quiet-card-"), "plc.db"));
  slack = new FakeSlack({ now: () => clock, users: { U0ETHAN: { name: "Ethan" }, U0NINA: { name: "Nina" } } });
  pushes = [];
  intakes = 0;
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

// Two plain notices (no reply needed) and one real question.
const NOTICE_1 = "FYI, the staging deploy for PROJ-123 is done.";
const NOTICE_2 = "Also, the retro moved to Thursday afternoon.";
const QUESTION = "Could you check why the nightly build failed?";
const needsReply = (state: string) => ((state.split("\n\n")[0] ?? "").includes("Could you") ? 0.9 : 0.05);

// hold: the first intake waits until release() is called, so a second message arrives before the first is settled.
function setup(options: { hold?: boolean } = {}) {
  const base = scriptedSmartModel({ answers: { ask_kind: "other", needs_reply: needsReply } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  const model: SmartModel = {
    ...base,
    decide: async (state, questions, opts) => {
      if (opts?.purpose === "channel_intake") intakes += 1;
      if (options.hold && !held && opts?.purpose === "channel_intake") {
        held = true;
        await gate;
      }
      return base.decide(state, questions, opts);
    },
  };
  const dispatcher = new FakeAgentTaskDispatcher(db, {});
  const hub = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
    credentials: { credential: async () => slack.credential }, now: () => clock, smartModel: () => model,
    classifyTimeoutMs: 60_000, audit: { rate: 0 }, push: (notice) => pushes.push(notice),
    lead: { dispatcher, available: () => true, taken: () => false },
  });
  dispatcher.hub = hub;
  hubs.push(hub);
  return { hub, release, dispatcher };
}

const messageEvents = () => listEvents(db, { kind: MESSAGE_EVENT_KIND });
const outward = () => slack.calls.filter((call) => call.method === "chat.postMessage" || call.method === "reactions.add");

describe("a colleague's DM that needs no reply", () => {
  it("opens one quiet card, and a second notice joins it: no push, nothing for Lead, nothing sent", async () => {
    const { hub, dispatcher } = setup();
    const first = (await hub.receive("slack", slack.dm("U0ETHAN", NOTICE_1))).items[0]!;
    await hub.idle();
    const second = (await hub.receive("slack", slack.dm("U0ETHAN", NOTICE_2))).items[0]!;
    await hub.idle();
    await hub.tick();

    const cards = listChannelCardsForObject(db, first.objectKey);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      state: "open", delivery: "card", firstSeq: first.seq, lastSeq: second.seq, messageCount: 2, sender: { name: "Ethan", trust: "colleague" },
    });
    expect(second.cardId).toBe(cards[0]!.id);
    // Low reply need is no reason to push, wake Lead or reply.
    expect(pushes).toEqual([]);
    expect(messageEvents()).toEqual([]);
    expect(dispatcher.requests).toEqual([]);
    expect(outward()).toEqual([]);
    // The messages are not closed as "no action": they wait on the card.
    expect(getEvent(db, first.seq!)!.disposition).not.toBe("no_action");
    expect(listEvents(db, { kind: "channel.reply.not_needed" })).toEqual([]);
    // The card says what the authority table decided: do not disturb you.
    const authority = hub.cardDto(cards[0]!).handling?.authority;
    expect(authority).toMatchObject({ action: "skip" });
    expect(authority?.reason).toContain("同事的私信照样放进会话卡，不推送，不代你回");
  });

  it("still opens one card when the second notice arrives before the first is judged", async () => {
    const { hub, release } = setup({ hold: true });
    const first = (await hub.receive("slack", slack.dm("U0ETHAN", NOTICE_1))).items[0]!;
    await expect.poll(() => intakes).toBe(1);
    const second = (await hub.receive("slack", slack.dm("U0ETHAN", NOTICE_2))).items[0]!;
    release();
    await hub.idle();
    await hub.tick();
    const cards = listChannelCardsForObject(db, first.objectKey);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ state: "open", delivery: "card", firstSeq: first.seq, lastSeq: second.seq, messageCount: 2 });
    expect(pushes).toEqual([]);
    expect(messageEvents()).toEqual([]);
  });

  it("hands a real question in the same DM to Lead on the same card", async () => {
    const { hub } = setup();
    const notice = (await hub.receive("slack", slack.dm("U0ETHAN", NOTICE_1))).items[0]!;
    await hub.idle();
    const ask = (await hub.receive("slack", slack.dm("U0ETHAN", QUESTION))).items[0]!;
    await hub.idle();
    const cards = listChannelCardsForObject(db, notice.objectKey);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ state: "open", messageCount: 2 });
    expect(messageEvents().map((event) => event.payload.forSeq)).toEqual([ask.seq]);
  });

  it("keeps a separate card per DM: another colleague's notice gets its own quiet card", async () => {
    const { hub } = setup();
    const ethan = (await hub.receive("slack", slack.dm("U0ETHAN", NOTICE_1))).items[0]!;
    const nina = (await hub.receive("slack", slack.dm("U0NINA", NOTICE_2))).items[0]!;
    await hub.idle();
    expect(listChannelCardsForObject(db, ethan.objectKey)).toMatchObject([{ messageCount: 1, sender: { name: "Ethan" } }]);
    expect(listChannelCardsForObject(db, nina.objectKey)).toMatchObject([{ messageCount: 1, sender: { name: "Nina" } }]);
    expect(pushes).toEqual([]);
  });
});

describe("other places keep their delivery rules", () => {
  it("records a group chat notice that needs no reply, without a card", async () => {
    const { hub } = setup();
    const item = (await hub.receive("slack", slack.groupDm("U0ETHAN", NOTICE_1))).items[0]!;
    await hub.idle();
    expect(listChannelCardsForObject(db, item.objectKey)).toEqual([]);
    expect(getEvent(db, item.seq!)!.disposition).toBe("no_action");
    expect(listEvents(db, { kind: "channel.reply.not_needed" })).toHaveLength(1);
  });

  it("records a channel mention that needs no reply, without a card", async () => {
    const { hub } = setup();
    const item = (await hub.receive("slack", slack.mention("U0ETHAN", NOTICE_1))).items[0]!;
    await hub.idle();
    expect(listChannelCardsForObject(db, item.objectKey)).toEqual([]);
  });

  it("only records a bot's DM", async () => {
    const { hub } = setup();
    const item = (await hub.receive("slack", slack.dm("U0BUILD", "Build #42 passed", { bot: true }))).items[0]!;
    await hub.idle();
    expect(item).toMatchObject({ delivery: "record", cardId: null });
    expect(listChannelCardsForObject(db, item.objectKey)).toEqual([]);
  });

  it("only records a colleague's DM when the delivery rule says record only", async () => {
    // The Slack source seeds its delivery order when the hub is built.
    const { hub } = setup();
    const seeded = getStandingOrder(db, "channel.slack.delivery")!;
    const params = (seeded.action as { params: Record<string, unknown> }).params;
    const onlyTrusted = { fields: { "payload.sender.trust": "trusted" } };
    updateStandingOrderByUser(db, {
      id: "channel.slack.delivery", reason: "test: record colleagues' DMs only", resolvedBy: "user via test",
      patch: { action: { ...seeded.action, params: { ...params, cardWhen: onlyTrusted, digestWhen: onlyTrusted } } as never },
    });
    const item = (await hub.receive("slack", slack.dm("U0ETHAN", NOTICE_1))).items[0]!;
    await hub.idle();
    expect(item).toMatchObject({ delivery: "record", cardId: null });
    expect(listChannelCardsForObject(db, item.objectKey)).toEqual([]);
  });
});
