// An outside conversation that floods Lead (ticket #533, 2026-11-25). A bot that the user asked to run a job in a thread kept
// posting placeholders and progress lines and deleting the old ones. The new "a bot answers what you just asked it" rule took all
// of them as answers, the deletes too: their body is the source's "deleted a message" note, which is not empty. Lead was woken more
// than ten times in a few minutes, judged "no action" every time, and could not stop it.
// Now:
//   - a deleted message never counts as an answer: it opens no card, wakes no Lead and asks no model. When the conversation has an
//     open card, only that message is marked deleted on the card;
//   - the breaker: when one conversation woke Lead 5 times in 10 minutes and Lead judged "no action" each time, the conversation
//     is muted for 30 minutes. Its messages are only recorded. The user gets one Lead activity card with "Unmute". It comes back
//     on its own;
//   - Lead can mute a conversation itself for up to 120 minutes (channel_conversation.mute), also in a turn that an outside message
//     woke, but then only the conversation that woke it;
//   - a person's message and a bot's real answer are handed to Lead as before.
// Since #71 (master, 2026-11-25) a bot's answer wakes Lead once the bot has been quiet for BOT_ANSWER_SETTLE_MS: one wake per
// round of answers. The breaker still counts those wakes: a bot that answers in rounds, each needing no action, gets muted.
// Real SQLite, the real Slack source, fake Slack, a scripted SmartModel, Lead connected as in the daemon. All names are made up.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CHANNEL_MUTE_ENDED_KIND, CHANNEL_MUTE_STARTED_KIND, MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import {
  activeChannelMute, channelMutePolicy, getEvent, getLocale, getStandingOrder, listChannelCardsForObject, listEvents, listLeadActivityEvents, openDb,
  proposeStandingOrderChange, type Db, type EventRecord,
} from "@pi-lead-child/store";
import {
  BOT_ANSWER_SETTLE_MS, ChannelHub, ChannelRegistry, breakerCheck, createSlackChannelAdapter, leadActivityCardAction, runUiAction,
} from "../src/index.js";
import { channelMuteMessages } from "../src/channels/mute.messages.js";
import { FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-mute-"), "plc.db"));
  clock = new Date("2026-11-25T05:40:00.000Z");
  slack = new FakeSlack({ now: () => clock, users: { U0RUNBOT: { name: "Run Bot" }, U0NINA: { name: "Nina" }, U0ETHAN: { name: "Ethan" } } });
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

const MINUTE = 60_000;
const later = (ms: number) => { clock = new Date(clock.getTime() + ms); };
const QUESTION = "Please run the nightly report job once more and post the summary here.";

// needsReply: what the intake answers for "does the user need to reply". A bot's progress line needs none.
function setup(needsReply = 0.05) {
  const model = scriptedSmartModel({ answers: { ask_kind: "other", needs_reply: needsReply } });
  const dispatcher = new FakeAgentTaskDispatcher(db, {});
  const hub = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
    credentials: { credential: async () => slack.credential }, now: () => clock, smartModel: () => model,
    classifyTimeoutMs: 60_000, audit: { rate: 0 }, lead: { dispatcher, available: () => true, taken: () => false },
  });
  dispatcher.hub = hub;
  hubs.push(hub);
  return { hub, model };
}

const wakes = (): EventRecord[] => listEvents(db, { kind: MESSAGE_EVENT_KIND });
const openCards = (objectKey: string) => listChannelCardsForObject(db, objectKey).filter((card) => card.state !== "handled" && card.state !== "dismissed");

// The root of the DM thread with the bot, and Lead asking it there on the user's behalf (Slack pushes the message back).
async function askBot(hub: ChannelHub): Promise<string> {
  const root = slack.dm("U0RUNBOT", "Hi, I am Run Bot. Ask me to run jobs.", { bot: true });
  await hub.receive("slack", root);
  await hub.idle();
  const thread = slack.messageOf(root).ts;
  await askAgain(hub, thread);
  return thread;
}

async function askAgain(hub: ChannelHub, thread: string) {
  await hub.sendMessage(`slack:D0RUNBOT:${thread}`, { text: QUESTION, words: "assistant", by: "lead for user via test", forUser: true });
  await hub.receive("slack", slack.echoOf(slack.sent("D0RUNBOT").at(-1)!));
  await hub.idle();
}

// The bot posts in the thread; returns the delivery (to edit or delete it later) and the receive item.
async function botPosts(hub: ChannelHub, thread: string, text: string) {
  const delivery = slack.dm("U0RUNBOT", text, { bot: true, thread });
  const item = (await hub.receive("slack", delivery)).items[0]!;
  await hub.idle();
  return { delivery, item };
}

// The bot answers in the thread and then stays quiet: after BOT_ANSWER_SETTLE_MS the tick hands the answer to Lead (#71).
async function botAnswers(hub: ChannelHub, thread: string, text: string) {
  const posted = await botPosts(hub, thread, text);
  await settle(hub);
  return posted;
}

async function settle(hub: ChannelHub) {
  later(BOT_ANSWER_SETTLE_MS);
  await hub.tick();
  await hub.idle();
}

// The event that handed the bot's answer to Lead (the settled answer, with answersAsk).
const settledAnswers = () => listEvents(db, { limit: 1000 }).filter((event) => event.source === "slack" && event.payload.answersAsk === true);

// Lead judges the newest message event "no action", as it did on 11-25.
async function leadSaysNoAction(hub: ChannelHub) {
  const latest = wakes().at(-1)!;
  await hub.leadDisposed(latest.seq, { disposition: "no_action", reason: "a progress line of the job, nothing to do" });
  await hub.idle();
}

describe("a deleted message", () => {
  it("is not an answer: it opens no card, wakes no Lead and asks no model", async () => {
    const { hub, model } = setup();
    const thread = await askBot(hub);
    later(MINUTE);
    const progress = await botAnswers(hub, thread, "50 steps, 4 failed · continued below");
    expect(wakes()).toHaveLength(1);
    await leadSaysNoAction(hub);
    const calls = model.calls.length;

    later(MINUTE);
    const deleted = (await hub.receive("slack", slack.remove(progress.delivery))).items[0]!;
    await hub.idle();

    expect(deleted).toMatchObject({ kind: "slack.message.deleted", delivery: "record", cardId: null });
    const event = getEvent(db, deleted.seq!)!;
    expect(event.payload).not.toHaveProperty("answersAsk");
    expect(event.payload).toMatchObject({ amends: "deleted", channelDelivery: "record", urgency: { reason: "deleted" } });
    expect(model.calls.length).toBe(calls);
    expect(wakes()).toHaveLength(1);
    expect(openCards(deleted.objectKey)).toEqual([]);
  });

  // The 11-25 shape: the bot deletes its progress line while the card of its answer is still open, before Lead has decided.
  // Before the fix the delete merged into the card and asked the intake and Lead again.
  it("does not ask again when the bot deletes a line while the card of its answer is still open", async () => {
    const { hub, model } = setup();
    const thread = await askBot(hub);
    later(MINUTE);
    const progress = await botAnswers(hub, thread, "99 steps, 35 failed · continued below");
    const [card] = openCards(progress.item.objectKey);
    expect(card).toBeDefined();
    expect(wakes()).toHaveLength(1);
    const calls = model.calls.length;

    later(2_000);
    const deleted = (await hub.receive("slack", slack.remove(progress.delivery))).items[0]!;
    await hub.idle();

    expect(deleted).toMatchObject({ delivery: "record", cardId: card!.id });
    expect(getEvent(db, deleted.seq!)!.payload).not.toHaveProperty("answersAsk");
    expect(model.calls.length).toBe(calls);
    expect(wakes()).toHaveLength(1);
    const after = listChannelCardsForObject(db, progress.item.objectKey).find((candidate) => candidate.id === card!.id)!;
    expect(after).toMatchObject({ state: card!.state, messageCount: card!.messageCount, lastSeq: card!.lastSeq });
    // The deleted line was the newest on the card (the settled answer): the excerpt shows the delete note, not the old text.
    expect(after.excerpt).toBe(getEvent(db, deleted.seq!)!.payload.text);
  });

  it("only marks the message deleted on an open card: no new request, no model, the card keeps its state", async () => {
    const { hub, model } = setup(0.9);
    const first = slack.dm("U0NINA", "Can you check why the PROJ-123 build is red?");
    await hub.receive("slack", first);
    await hub.idle();
    later(30_000);
    await hub.receive("slack", slack.dm("U0NINA", "It started after the last merge."));
    await hub.idle();
    const objectKey = "slack:D0NINA:main";
    const [card] = openCards(objectKey);
    expect(card).toBeDefined();
    const before = { calls: model.calls.length, wakes: wakes().length, version: card!.version };
    expect((hub.cardDto(card!).recent ?? []).map((message) => message.text)).toContain("Can you check why the PROJ-123 build is red?");

    later(MINUTE);
    const deleted = (await hub.receive("slack", slack.remove(first))).items[0]!;
    await hub.idle();

    const after = listChannelCardsForObject(db, objectKey).find((candidate) => candidate.id === card!.id)!;
    expect(deleted).toMatchObject({ delivery: "record", cardId: card!.id });
    expect(after).toMatchObject({ state: card!.state, messageCount: card!.messageCount, lastSeq: card!.lastSeq, excerpt: card!.excerpt });
    expect(after.version).toBeGreaterThan(before.version);
    const recent = (hub.cardDto(after).recent ?? []).map((message) => message.text);
    expect(recent).not.toContain("Can you check why the PROJ-123 build is red?");
    expect(recent).toContain(getEvent(db, deleted.seq!)!.payload.text);
    expect(recent).toContain("It started after the last merge.");
    expect(model.calls.length).toBe(before.calls);
    expect(wakes()).toHaveLength(before.wakes);
  });
});

describe("the breaker of one conversation", () => {
  it("mutes it after 5 wakes in 10 minutes that all needed no action, records the rest, tells the user once, and comes back", async () => {
    const { hub, model } = setup();
    const thread = await askBot(hub);
    // Five rounds: each round the bot posts a line and goes quiet, the tick hands it to Lead, Lead says "no action".
    for (let step = 1; step <= 5; step += 1) {
      later(10_000);
      await botAnswers(hub, thread, `Step ${step} of 9 finished`);
      expect(wakes()).toHaveLength(step);
      await leadSaysNoAction(hub);
    }
    const objectKey = `slack:D0RUNBOT:${thread}`;
    const mute = activeChannelMute(db, objectKey, clock);
    expect(mute).toMatchObject({ by: "breaker", until: new Date(clock.getTime() + 30 * MINUTE).toISOString() });

    // One Lead activity card for the user, with "Unmute".
    const started = listEvents(db, { kind: CHANNEL_MUTE_STARTED_KIND });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ level: "digest", payload: { conversation: objectKey, by: "breaker", minutes: 30 } });
    expect(started[0]!.payload.wakes).toEqual(wakes().map((event) => event.seq));
    expect(listLeadActivityEvents(db, { afterSeq: 0, limit: 100 }).map((event) => event.kind)).toContain(CHANNEL_MUTE_STARTED_KIND);
    expect(leadActivityCardAction(db, started[0]!, clock)).toEqual({
      target: { type: "channel_conversation", id: objectKey }, action: "unmute", label: channelMuteMessages(getLocale(db)).unmute,
    });

    // While muted: recorded with the mute on it, no card, no Lead, no model.
    const calls = model.calls.length;
    later(MINUTE);
    const quiet = await botAnswers(hub, thread, "Step 6 of 9 finished");
    expect(quiet.item).toMatchObject({ delivery: "record", cardId: null });
    expect(getEvent(db, quiet.item.seq!)!.payload).toMatchObject({ muted: { by: "breaker" }, urgency: { reason: "muted" } });
    expect(getEvent(db, quiet.item.seq!)!.payload).not.toHaveProperty("answersAsk");
    expect(getEvent(db, quiet.item.seq!)!.payload).not.toHaveProperty("answerPending");
    expect(model.calls.length).toBe(calls);
    expect(wakes()).toHaveLength(5);
    expect(listEvents(db, { kind: CHANNEL_MUTE_STARTED_KIND })).toHaveLength(1);

    // 30 minutes later it is back on its own: no event, no tick needed. The user asks again, the answer wakes Lead.
    later(30 * MINUTE);
    expect(activeChannelMute(db, objectKey, clock)).toBeNull();
    expect(leadActivityCardAction(db, started[0]!, clock)).toBeNull();
    await askAgain(hub, thread);
    later(MINUTE);
    await botAnswers(hub, thread, "Summary: 9 of 9 steps finished, report at reports/nightly.html");
    expect(settledAnswers().at(-1)!.payload).toMatchObject({ text: "Summary: 9 of 9 steps finished, report at reports/nightly.html", channelDelivery: "card" });
    expect(wakes()).toHaveLength(6);
    // The old wakes are before the mute ended: one more "no action" does not trip the breaker again.
    await leadSaysNoAction(hub);
    expect(activeChannelMute(db, objectKey, clock)).toBeNull();
  });

  it("does not trip when one of the wakes needed Lead, or a wake is still waiting for Lead", async () => {
    const { hub } = setup();
    const thread = await askBot(hub);
    for (let step = 1; step <= 4; step += 1) {
      later(10_000);
      await botAnswers(hub, thread, `Step ${step} of 9 finished`);
      if (step === 2) {
        await hub.leadDisposed(wakes().at(-1)!.seq, { disposition: "told_user", reason: "the bot asks for a parameter", draft: "Use yesterday." });
        await hub.idle();
      } else {
        await leadSaysNoAction(hub);
      }
    }
    later(10_000);
    await botAnswers(hub, thread, "Step 5 of 9 finished");
    await leadSaysNoAction(hub);
    const objectKey = `slack:D0RUNBOT:${thread}`;
    expect(activeChannelMute(db, objectKey, clock)).toBeNull();
    // Five wakes in the window, but one of them needed Lead: checking again does not trip either.
    expect(wakes()).toHaveLength(5);
    expect(breakerCheck(db, objectKey, clock)).toBeNull();
  });

  it("is cancelled by the user's Unmute, and the old wakes do not trip it again", async () => {
    const { hub } = setup();
    const thread = await askBot(hub);
    for (let step = 1; step <= 5; step += 1) {
      later(10_000);
      await botAnswers(hub, thread, `Step ${step} of 9 finished`);
      await leadSaysNoAction(hub);
    }
    const objectKey = `slack:D0RUNBOT:${thread}`;
    const started = listEvents(db, { kind: CHANNEL_MUTE_STARTED_KIND })[0]!;
    await runUiAction(db, { now: clock, target: { type: "channel_conversation", id: objectKey }, action: "unmute", caller: { kind: "user" } });
    expect(activeChannelMute(db, objectKey, clock)).toBeNull();
    expect(listEvents(db, { kind: CHANNEL_MUTE_ENDED_KIND })).toMatchObject([{ payload: { by: "user", startedSeq: started.seq } }]);
    // The card updates in place: its newest event is the end, without a button.
    expect(leadActivityCardAction(db, listEvents(db, { kind: CHANNEL_MUTE_ENDED_KIND })[0]!, clock)).toBeNull();
    expect(getEvent(db, started.seq)!.disposition).toBe("seen");

    later(10_000);
    await botAnswers(hub, thread, "Step 6 of 9 finished");
    expect(wakes()).toHaveLength(6);
    await leadSaysNoAction(hub);
    expect(activeChannelMute(db, objectKey, clock)).toBeNull();
  });

  // 静音让交给你和 Lead 的更少：更容易熔断、静音更久要用户批准；反方向 Lead 可以直接改，熔断马上按新的数算。
  it("lets Lead make it trip less on its own, and needs the user's approval to make it trip more", async () => {
    const mute = getStandingOrder(db, "channel.mute")!;
    const params = (patch: Record<string, number>) => ({ action: { ...mute.action, params: { ...(mute.action as { params: object }).params, ...patch } } });
    const fewer = proposeStandingOrderChange(db, { op: "update", id: "channel.mute", reason: "only after 8 wakes", patch: params({ breakerWakes: 8 }) });
    expect(fewer.outcome).toBe("applied");
    expect(channelMutePolicy(db).params.breakerWakes).toBe(8);
    const more = proposeStandingOrderChange(db, { op: "update", id: "channel.mute", reason: "mute longer", patch: params({ breakerWakes: 8, breakerMuteMs: 90 * MINUTE }) });
    expect(more.outcome).toBe("pending_approval");
    expect(channelMutePolicy(db).params.breakerMuteMs).toBe(30 * MINUTE);
  });

  it("reads its numbers from the standing order channel.mute", () => {
    expect(getStandingOrder(db, "channel.mute")).toMatchObject({
      author: "system",
      action: { type: "rule", rule: "channel.mute", params: { breakerWindowMs: 10 * MINUTE, breakerWakes: 5, breakerMuteMs: 30 * MINUTE, maxMuteMs: 120 * MINUTE } },
    });
  });
});

describe("Lead muting a conversation", () => {
  async function twoConversations(hub: ChannelHub) {
    const thread = await askBot(hub);
    later(MINUTE);
    await botPosts(hub, thread, "Step 1 of 9 finished");
    await hub.receive("slack", slack.dm("U0ETHAN", "Lunch at 12?"));
    await hub.idle();
    return { flooding: `slack:D0RUNBOT:${thread}`, other: "slack:D0ETHAN:main" };
  }

  it("mutes the conversation that woke the turn for up to 120 minutes, records it with Undo, and comes back", async () => {
    const { hub, model } = setup();
    const { flooding } = await twoConversations(hub);
    const target = { type: "channel_conversation", id: flooding } as const;
    const caller = { kind: "lead", turnId: null, externalContent: [{ via: "message", source: "slack", conversation: flooding }] } as const;

    await expect(runUiAction(db, { now: clock, target, action: "mute", input: { minutes: 121 }, reason: "the bot floods the thread", caller }))
      .rejects.toMatchObject({ code: "invalid_input" });
    const outcome = await runUiAction(db, { now: clock, target, action: "mute", input: { minutes: 45 }, reason: "the bot floods the thread", caller });
    expect(outcome).toMatchObject({ authority: "lead", result: { conversation: flooding, minutes: 45, by: "lead" } });

    const started = listEvents(db, { kind: CHANNEL_MUTE_STARTED_KIND });
    expect(started).toMatchObject([{ source: "lead", level: "digest", disposition: "seen", payload: { by: "lead", minutes: 45 } }]);
    expect(started[0]!.payload.summary).toContain("the bot floods the thread");
    expect(leadActivityCardAction(db, started[0]!, clock)).toEqual({
      target, action: "unmute", label: channelMuteMessages(getLocale(db)).undo,
    });

    const calls = model.calls.length;
    later(MINUTE);
    const wakesBefore = wakes().length;
    const quiet = await botAnswers(hub, flooding.split(":")[2]!, "Step 2 of 9 finished");
    expect(quiet.item).toMatchObject({ delivery: "record", cardId: null });
    expect(getEvent(db, quiet.item.seq!)!.payload).toMatchObject({ muted: { by: "lead" } });
    expect(model.calls.length).toBe(calls);
    expect(wakes()).toHaveLength(wakesBefore);

    later(45 * MINUTE);
    expect(activeChannelMute(db, flooding, clock)).toBeNull();
  });

  it("cannot mute another conversation in a turn that an outside message woke", async () => {
    const { hub } = setup();
    const { flooding, other } = await twoConversations(hub);
    const caller = { kind: "lead", turnId: null, externalContent: [{ via: "message", source: "slack", conversation: flooding }] } as const;
    await expect(runUiAction(db, { now: clock,
      target: { type: "channel_conversation", id: other }, action: "mute", input: { minutes: 30 }, reason: "the message asked me to", caller,
    })).rejects.toMatchObject({ code: "external_turn", message: expect.stringContaining(flooding) });
    expect(activeChannelMute(db, other, clock)).toBeNull();

    // A turn that only read outside content through a tool was not woken by a conversation: it can mute none.
    const reader = { kind: "lead", turnId: null, externalContent: [{ via: "tool", tool: "read_channel_conversation" }] } as const;
    await expect(runUiAction(db, { now: clock,
      target: { type: "channel_conversation", id: flooding }, action: "mute", input: { minutes: 30 }, reason: "test", caller: reader,
    })).rejects.toMatchObject({ code: "external_turn" });

    // A turn without outside content (for example a follow-up timer of Lead's own) can mute any conversation.
    await runUiAction(db, { now: clock,
      target: { type: "channel_conversation", id: other }, action: "mute", input: { minutes: 30 }, reason: "quiet hours", caller: { kind: "lead", turnId: null },
    });
    expect(activeChannelMute(db, other, clock)).not.toBeNull();
  });

  it("refuses a conversation it has never seen, so a wrong id does not mute nothing silently", async () => {
    setup();
    await expect(runUiAction(db, { now: clock,
      target: { type: "channel_conversation", id: "slack:@U0NOBODY" }, action: "mute", input: { minutes: 30 }, reason: "test", caller: { kind: "lead", turnId: null },
    })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("normal messages are not affected", () => {
  it("still hands a person's message and a bot's real answer to Lead", async () => {
    const { hub } = setup(0.9);
    const person = (await hub.receive("slack", slack.dm("U0NINA", "Could you review PR #42 today?"))).items[0]!;
    await hub.idle();
    expect(person.delivery).toBe("card");
    const thread = await askBot(hub);
    later(MINUTE);
    await botAnswers(hub, thread, "Summary: 9 of 9 steps finished, report at reports/nightly.html");
    expect(settledAnswers()).toMatchObject([{ payload: { text: "Summary: 9 of 9 steps finished, report at reports/nightly.html", channelDelivery: "card" } }]);
    expect(wakes()).toHaveLength(2);
  });
});

// The sequence of 11-25 13:47–13:53 (local time), with made-up names and texts: the bot answers in the thread with placeholders and
// progress lines and deletes each progress line once the next one is out. Before the fixes every post and every delete woke Lead
// (#740–#743 opened one after another). Now (#71 on master plus this ticket): the deletes never count, the flood wakes Lead at most
// once after the bot goes quiet. When the bot keeps answering in rounds that each need no action, the fifth wake mutes the thread.
describe("replay of the 11-25 flood", () => {
  it("records the deletes, wakes Lead at most once per quiet round, and mutes the thread on the fifth no-action wake", async () => {
    const { hub, model } = setup();
    const thread = await askBot(hub);
    const objectKey = `slack:D0RUNBOT:${thread}`;
    const lines = ["_Thinking..._", "50 steps, 4 failed · continued below", "_Thinking..._", "99 steps, 35 failed · continued below",
      "_Thinking..._", "118 steps, 54 failed · continued below", "_Thinking..._", "119 steps, 54 failed · continued below"];
    let last: Awaited<ReturnType<typeof botPosts>> | null = null;
    for (const line of lines) {
      later(20_000);
      const posted = await botPosts(hub, thread, line);
      // The previous progress line goes away when the next one is out.
      if (last && last.delivery && line.includes("continued below")) {
        // A DM thread without a lane yet: the Slack source drops the delete. Once recorded, it is only recorded.
        const removed = (await hub.receive("slack", slack.remove(last.delivery))).items[0];
        await hub.idle();
        if (removed) {
          expect(removed).toMatchObject({ delivery: "record", cardId: null });
          expect(getEvent(db, removed.seq!)!.payload).not.toHaveProperty("answerPending");
        }
      }
      if (line.includes("continued below")) last = posted;
    }
    // While the bot writes, nothing reaches Lead.
    expect(wakes()).toEqual([]);
    await settle(hub);
    // One wake for the whole flood: the last progress line that is still there. No delete reached Lead.
    expect(wakes().map((event) => event.payload.text)).toEqual(["119 steps, 54 failed · continued below"]);
    await leadSaysNoAction(hub);

    // The bot goes on in rounds, each round one progress line and a quiet minute; Lead says "no action" each time.
    for (const step of [150, 180, 206, 230]) {
      later(10_000);
      await botAnswers(hub, thread, `${step} steps, 54 failed · continued below`);
      await leadSaysNoAction(hub);
    }
    expect(wakes()).toHaveLength(5);
    expect(activeChannelMute(db, objectKey, clock)).toMatchObject({ by: "breaker" });

    // Muted: more posts and deletes are only recorded. No model, no Lead.
    const calls = model.calls.length;
    for (const line of ["_Thinking..._", "260 steps, 54 failed · continued below"]) {
      later(20_000);
      const posted = await botPosts(hub, thread, line);
      expect(posted.item).toMatchObject({ delivery: "record", cardId: null });
      await hub.receive("slack", slack.remove(posted.delivery));
      await hub.idle();
    }
    await settle(hub);
    expect(model.calls.length).toBe(calls);
    expect(wakes()).toHaveLength(5);
    expect(listEvents(db, { kind: CHANNEL_MUTE_STARTED_KIND })).toHaveLength(1);
  });
});
