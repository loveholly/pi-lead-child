// A bot that streams progress while it answers (2026-11-25, replay with made-up names and text). The user asked a bot in a
// channel thread to run a long job. For six minutes the bot kept posting progress placeholders ("206 steps, 54 failed ·
// continued below", "_Thinking..._"), edited them and deleted them. Every post, edit and delete counted as "the bot answers
// the question you just asked", so each opened a new card and woke Lead: about 20 cards, and the background model calls
// went over the hourly cap.
// Now a bot's answer is judged once the bot has been quiet for BOT_ANSWER_SETTLE_MS:
//   - the whole burst of placeholders, edits and deletions opens at most one card and wakes Lead at most once;
//   - a deletion ("（删除了一条消息）") never counts as an answer and wakes nobody;
//   - the message with the real result that is left when the bot stops opens a card and wakes Lead as before;
//   - nothing here knows the bot: only structure (bot sender, edits, deletions, quiet time, status-line format).
// Real SQLite, the real Slack source, fake Slack, a scripted SmartModel, Lead connected as in the daemon.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CHANNEL_EVENT_KINDS, MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { getEvent, listChannelCardsForObject, listEvents, openDb, type Db } from "@pi-lead-child/store";
import type { ChannelDelivery } from "../src/channels/types.js";
import { BOT_ANSWER_SETTLE_MS, ChannelHub, ChannelRegistry, createSlackChannelAdapter, isBotStatusLine, settledBotAnswer } from "../src/index.js";
import { FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-bot-progress-"), "plc.db"));
  clock = new Date("2026-11-25T05:40:00.000Z");
  slack = new FakeSlack({ now: () => clock, users: { U0RUNBOT: { name: "Run Bot" }, U0NINA: { name: "Nina" } } });
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

const later = (ms: number) => { clock = new Date(clock.getTime() + ms); };
const RESULT = "Done · 622 steps, 517 failed\nStopped. Current state:\n• Step 1 finished: the repository is on `5fa983c`.\n• Charts installed.";

// taken: whether Lead has already taken its queued inputs (then an edit would be judged again as a new message).
let taken = false;
function setup() {
  taken = false;
  const model = scriptedSmartModel({ answers: { ask_kind: "other", needs_reply: 0.05 } });
  const dispatcher = new FakeAgentTaskDispatcher(db, {});
  const hub = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
    credentials: { credential: async () => slack.credential }, now: () => clock, smartModel: () => model,
    classifyTimeoutMs: 60_000, audit: { rate: 0 }, lead: { dispatcher, available: () => true, taken: () => taken },
  });
  dispatcher.hub = hub;
  hubs.push(hub);
  return { hub };
}

const messageEvents = () => listEvents(db, { kind: MESSAGE_EVENT_KIND });
const settledMarkers = () => listEvents(db, { kind: CHANNEL_EVENT_KINDS.botAnswerSettled });

// The user starts a thread in a channel and asks the bot there (the question mentions the bot).
async function userAsksInChannelThread(hub: ChannelHub): Promise<{ thread: string; objectKey: string }> {
  const root = slack.selfReply("C0PERF", "<@U0RUNBOT> run the nightly report and tell me the result");
  await hub.receive("slack", root);
  await hub.idle();
  const thread = slack.messageOf(root).ts;
  return { thread, objectKey: `slack:C0PERF:${thread}` };
}

// One delivery, then a tick of the daemon's poller (every few seconds in the daemon).
async function deliver(hub: ChannelHub, delivery: ChannelDelivery, gapMs: number) {
  later(gapMs);
  const result = await hub.receive("slack", delivery);
  await hub.idle();
  await hub.tick();
  await hub.idle();
  return result.items[0];
}

// One round of progress: an empty post, edits through placeholders to a progress line, then the bot deletes it and goes on.
async function progressRound(hub: ChannelHub, thread: string, steps: number, gapMs: number) {
  const post = slack.chatter("U0RUNBOT", "", "C0PERF", { thread, bot: true });
  await deliver(hub, post, gapMs);
  await deliver(hub, slack.edit(post, "_Thinking..._"), 500);
  await deliver(hub, slack.edit(post, "memory source"), 500);
  await deliver(hub, slack.edit(post, `${steps} steps, 54 failed · continued below`), 500);
  return deliver(hub, slack.remove(post), 1_000);
}

describe("a bot that streams progress placeholders, edits and deletions while it answers", () => {
  it("opens one card and wakes Lead once, with the result that is left when the bot stops", async () => {
    const { hub } = setup();
    const { thread, objectKey } = await userAsksInChannelThread(hub);

    // Eight rounds with gaps up to 42 seconds, as in the incident: nothing opens a card or wakes Lead while the bot works.
    const gaps = [5_000, 30_000, 42_000, 12_000, 36_000, 3_000, 33_000, 20_000];
    for (const [index, gap] of gaps.entries()) {
      const deleted = await progressRound(hub, thread, 100 + index, gap);
      expect(getEvent(db, deleted!.seq!)!.payload).toMatchObject({ amends: "deleted", text: "（删除了一条消息）", channelDelivery: "record" });
      expect(getEvent(db, deleted!.seq!)!.payload).not.toHaveProperty("answerPending");
      expect(getEvent(db, deleted!.seq!)!.payload).not.toHaveProperty("answersAsk");
      expect(listChannelCardsForObject(db, objectKey)).toEqual([]);
      expect(messageEvents()).toEqual([]);
    }

    // The last message: a placeholder edited into the real result, then the bot stops.
    const last = slack.chatter("U0RUNBOT", "", "C0PERF", { thread, bot: true });
    await deliver(hub, last, 2_000);
    await deliver(hub, slack.edit(last, "_Thinking..._"), 500);
    await deliver(hub, slack.edit(last, RESULT), 500);
    later(BOT_ANSWER_SETTLE_MS - 5_000);
    await hub.tick();
    await hub.idle();
    expect(listChannelCardsForObject(db, objectKey)).toEqual([]);

    later(5_000);
    await hub.tick();
    await hub.idle();
    const cards = listChannelCardsForObject(db, objectKey);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.excerpt).toContain("Done · 622 steps");
    expect(messageEvents().map((event) => event.payload.text)).toEqual([RESULT]);
    expect(settledMarkers().map((event) => event.payload)).toMatchObject([{ senderId: "U0RUNBOT", answerSeq: expect.any(Number) }]);

    // More ticks change nothing.
    later(BOT_ANSWER_SETTLE_MS);
    await hub.tick();
    await hub.idle();
    expect(listChannelCardsForObject(db, objectKey)).toHaveLength(1);
    expect(messageEvents()).toHaveLength(1);
    expect(settledMarkers()).toHaveLength(1);
  });

  it.each([
    ["Lead has not taken the answer yet: the edit joins the queued answer", false, "merge_queued"],
    ["Lead has taken the answer: the edit is only recorded, not judged again", true, "rejudge"],
  ])("does not judge a touch-up of the result as a new answer (%s)", async (_name, leadTook, merge) => {
    const { hub } = setup();
    const { thread, objectKey } = await userAsksInChannelThread(hub);
    const answer = slack.chatter("U0RUNBOT", RESULT, "C0PERF", { thread, bot: true });
    await deliver(hub, answer, 5_000);
    later(BOT_ANSWER_SETTLE_MS);
    await hub.tick();
    await hub.idle();
    expect(messageEvents()).toHaveLength(1);

    taken = leadTook;
    const touched = await deliver(hub, slack.edit(answer, `${RESULT}\n• Retention cleanup scheduled.`), 10_000);
    const payload = getEvent(db, touched!.seq!)!.payload;
    expect(payload).not.toHaveProperty("answerPending");
    expect(payload).toMatchObject({ editMerge: merge, channelDelivery: "record" });
    later(BOT_ANSWER_SETTLE_MS);
    await hub.tick();
    await hub.idle();
    // Lead's inputs: the answer, and at most the same answer with the edit merged in while it still waits in the queue.
    expect(messageEvents().length).toBe(leadTook ? 1 : 2);
    expect(listChannelCardsForObject(db, objectKey)).toHaveLength(1);
    expect(settledMarkers()).toHaveLength(1);
  });

  it("opens no card and wakes nobody when the bot deletes everything it posted", async () => {
    const { hub } = setup();
    const { thread, objectKey } = await userAsksInChannelThread(hub);
    await progressRound(hub, thread, 50, 5_000);
    await progressRound(hub, thread, 99, 20_000);
    later(BOT_ANSWER_SETTLE_MS);
    await hub.tick();
    await hub.idle();
    expect(listChannelCardsForObject(db, objectKey)).toEqual([]);
    expect(messageEvents()).toEqual([]);
    expect(settledMarkers().map((event) => event.payload)).toMatchObject([{ senderId: "U0RUNBOT", answerSeq: null }]);
  });

  it("opens no card when only a status line is left", async () => {
    const { hub } = setup();
    const { thread, objectKey } = await userAsksInChannelThread(hub);
    const post = slack.chatter("U0RUNBOT", "", "C0PERF", { thread, bot: true });
    await deliver(hub, post, 5_000);
    await deliver(hub, slack.edit(post, "_Thinking..._"), 500);
    later(BOT_ANSWER_SETTLE_MS);
    await hub.tick();
    await hub.idle();
    expect(listChannelCardsForObject(db, objectKey)).toEqual([]);
    expect(messageEvents()).toEqual([]);
  });
});

describe("when a bot's answer is settled (inbound.ts, the decision boundary)", () => {
  const now = Date.parse("2026-11-25T06:00:00.000Z");
  const message = (seq: number, text: string, deleted = false) => ({ seq, text, deleted });

  it.each([
    ["the bot wrote 30 seconds ago", 30_000, [message(5, RESULT)], { state: "waiting" }],
    ["quiet, the result is left", 60_000, [message(3, "", true), message(5, RESULT)], { state: "answer", seq: 5 }],
    ["quiet, the latest of two kept messages", 60_000, [message(5, "First part of the result"), message(9, RESULT)], { state: "answer", seq: 9 }],
    ["quiet, everything deleted", 60_000, [message(3, "（删除了一条消息）", true), message(5, "99 steps", true)], { state: "none" }],
    ["quiet, only a status line", 60_000, [message(5, "_Thinking..._")], { state: "none" }],
    ["quiet, only an empty post", 60_000, [message(5, "  ")], { state: "none" }],
  ])("%s", (_name, quietMs, messages, expected) => {
    expect(settledBotAnswer({ now, lastActivityAt: now - quietMs, settleMs: BOT_ANSWER_SETTLE_MS, messages })).toEqual(expected);
  });

  it.each([
    ["_Thinking..._", true],
    ["Searching…", true],
    ["*Working on it...*", true],
    ["Run Bot (Assistant) is reviewing…", true],
    ["Thinking", false],
    ["Done.", false],
    ["Access is active. I will check the rest...\nand report back", false],
    [RESULT, false],
  ])("status line %j → %s", (text, expected) => {
    expect(isBotStatusLine(text)).toBe(expected);
  });
});
