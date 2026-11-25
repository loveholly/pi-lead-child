// A bot's answer to a question that Lead or the user just asked it (2026-11-25). Lead asked a bot in a DM thread whether a
// permission had gone through; the bot answered ten seconds later, but the event was recorded with an empty text and only
// recorded: bots' messages are record-only by the delivery rule, and the bot first posts an empty placeholder and then edits
// the answer into a block, an edit that the Slack source dropped because the message's `text` field did not change.
// Now:
//   - the text of a bot message whose body is only in blocks (markdown, rich_text) or attachments reaches the event;
//   - an edit that only changes blocks is not dropped, also in a bot's DM that has no lane;
//   - a bot message with a body that answers a question asked in the same DM or thread within 30 minutes opens a card and
//     is handed to Lead, even when the intake judges that it needs no reply. It is judged once the bot has been quiet for
//     BOT_ANSWER_SETTLE_MS (see channel-slack-bot-progress.test.ts for a bot that streams progress);
//   - every other bot message (nobody asked, asked too long ago, a channel thread where the question did not mention the bot)
//     is still only recorded.
// Real SQLite, the real Slack source, fake Slack, a scripted SmartModel, Lead connected as in the daemon. All names are made up.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { getEvent, listChannelCardsForObject, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { answersOwnerAsk, ASK_ANSWER_WINDOW_MS, BOT_ANSWER_SETTLE_MS, ChannelHub, ChannelRegistry, createSlackChannelAdapter } from "../src/index.js";
import { FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-bot-answer-"), "plc.db"));
  clock = new Date("2026-11-25T02:00:00.000Z");
  slack = new FakeSlack({ now: () => clock, users: { U0ASKBOT: { name: "Ask Bot" }, U0CALBOT: { name: "Calendar" }, U0NINA: { name: "Nina" } } });
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

const QUESTION = "Please check whether my access to the reporting tables is active now. Only reply with the result.";
const ANSWER = "*Result*: access to `reporting_daily` is active since 09:58. `reporting_events` is still waiting for approval by the data owner.";
const later = (ms: number) => { clock = new Date(clock.getTime() + ms); };

// The intake judges every message as needing no reply: an answer to the user's own question does not ask anything back.
function setup() {
  const model = scriptedSmartModel({ answers: { ask_kind: "other", needs_reply: 0.05 } });
  const dispatcher = new FakeAgentTaskDispatcher(db, {});
  const hub = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
    credentials: { credential: async () => slack.credential }, now: () => clock, smartModel: () => model,
    classifyTimeoutMs: 60_000, audit: { rate: 0 }, lead: { dispatcher, available: () => true, taken: () => false },
  });
  dispatcher.hub = hub;
  hubs.push(hub);
  return { hub };
}

const messageEvents = () => listEvents(db, { kind: MESSAGE_EVENT_KIND });

// The bot has been quiet long enough: the next tick judges its answer.
async function settle(hub: ChannelHub) {
  later(BOT_ANSWER_SETTLE_MS);
  await hub.tick();
  await hub.idle();
}

// Lead asks the bot in a thread of the DM with it (send_message on the user's behalf); Slack pushes the message back.
async function leadAsks(hub: ChannelHub, thread: string) {
  await hub.sendMessage(`slack:D0ASKBOT:${thread}`, { text: QUESTION, words: "assistant", by: "lead for user via test", forUser: true });
  const sent = slack.sent("D0ASKBOT").at(-1)!;
  await hub.receive("slack", slack.echoOf(sent));
  await hub.idle();
}

// The root of the DM thread: an earlier message of the bot.
async function threadRoot(hub: ChannelHub) {
  const root = slack.dm("U0ASKBOT", "Hi, I am Ask Bot. Ask me about data access.", { bot: true });
  await hub.receive("slack", root);
  await hub.idle();
  return slack.messageOf(root).ts;
}

describe("the text of a bot message whose body is only in blocks or attachments", () => {
  it("reaches the event from a markdown block", async () => {
    const { hub } = setup();
    const item = (await hub.receive("slack", slack.dm("U0ASKBOT", "", { bot: true, blocks: [{ type: "markdown", text: ANSWER }] }))).items[0]!;
    await hub.idle();
    expect(getEvent(db, item.seq!)!.payload).toMatchObject({ text: ANSWER, sender: { bot: true } });
  });

  it("reaches the event from rich_text and attachments, with mentions shown as names", async () => {
    const { hub } = setup();
    const blocks = [{
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [{ type: "user", user_id: "U0NINA" }, { type: "text", text: " approved the request." }] }],
    }];
    const attachments = [{ title: "Request 42", text: "Approved by the data owner", fields: [{ title: "Tables", value: "reporting_daily" }] }];
    const item = (await hub.receive("slack", slack.dm("U0ASKBOT", "", { bot: true, blocks, attachments }))).items[0]!;
    await hub.idle();
    expect(getEvent(db, item.seq!)!.payload.text).toBe("@Nina approved the request.\nRequest 42\nApproved by the data owner\nTables: reporting_daily");
  });

  it("keeps an edit that only changes the blocks, also in a bot's DM without a lane", async () => {
    const { hub } = setup();
    const placeholder = slack.dm("U0CALBOT", "", { bot: true });
    await hub.receive("slack", placeholder);
    await hub.idle();
    const edited = (await hub.receive("slack", slack.edit(placeholder, "", { blocks: [{ type: "markdown", text: "Standup in 10 minutes" }] }))).items[0];
    await hub.idle();
    expect(edited).toBeDefined();
    expect(getEvent(db, edited!.seq!)!).toMatchObject({ kind: "slack.message.edited", payload: { text: "Standup in 10 minutes" } });
  });
});

describe("a bot's answer to a question that Lead or the user just asked it", () => {
  it("opens a card and wakes Lead when the bot answers Lead's question in the DM thread", async () => {
    const { hub } = setup();
    const thread = await threadRoot(hub);
    await leadAsks(hub, thread);
    later(10_000);
    const answer = (await hub.receive("slack", slack.dm("U0ASKBOT", "", { bot: true, thread, blocks: [{ type: "markdown", text: ANSWER }] }))).items[0]!;
    await hub.idle();
    // Recorded first: the bot may still be writing.
    expect(getEvent(db, answer.seq!)!.payload).toMatchObject({ text: ANSWER, channelDelivery: "record", answerPending: { replyTarget: { thread_ts: thread } } });
    expect(messageEvents()).toEqual([]);

    await settle(hub);
    const settled = listEvents(db, { kind: "slack.dm.received" }).filter((event) => event.payload.answersAsk === true);
    expect(settled.map((event) => event.payload)).toMatchObject([{ text: ANSWER, answersAsk: true, channelDelivery: "card" }]);
    expect(listChannelCardsForObject(db, answer.objectKey).filter((card) => card.state === "open")).toHaveLength(1);
    expect(messageEvents().map((event) => event.payload.text)).toEqual([ANSWER]);
  });

  it("wakes Lead once the bot edits the answer into its empty placeholder", async () => {
    const { hub } = setup();
    const thread = await threadRoot(hub);
    await leadAsks(hub, thread);
    later(2_000);
    const placeholder = slack.dm("U0ASKBOT", "", { bot: true, thread });
    const head = (await hub.receive("slack", placeholder)).items[0]!;
    await hub.idle();
    // The empty placeholder alone is still only recorded: there is nothing to tell yet.
    expect(head).toMatchObject({ delivery: "record", cardId: null });
    expect(messageEvents()).toEqual([]);

    later(8_000);
    const edited = (await hub.receive("slack", slack.edit(placeholder, "", { blocks: [{ type: "markdown", text: ANSWER }] }))).items[0]!;
    await hub.idle();
    expect(getEvent(db, edited.seq!)!.payload).toMatchObject({ text: ANSWER, channelDelivery: "record", answerPending: {} });
    expect(messageEvents()).toEqual([]);

    await settle(hub);
    // Judged as a new message of the kind the placeholder had, with the edited text.
    const settled = listEvents(db, { kind: "slack.dm.received" }).filter((event) => event.payload.answersAsk === true);
    expect(settled.map((event) => event.payload)).toMatchObject([{ text: ANSWER, messageId: getEvent(db, head.seq!)!.payload.messageId }]);
    expect(listChannelCardsForObject(db, edited.objectKey).filter((card) => card.state === "open")).toHaveLength(1);
    expect(messageEvents().map((event) => event.payload.text)).toEqual([ANSWER]);
  });

  it("opens a card when the user asked the bot in the DM themselves", async () => {
    const { hub } = setup();
    const thread = await threadRoot(hub);
    await hub.receive("slack", slack.selfReply("D0ASKBOT", QUESTION, { thread }));
    await hub.idle();
    later(60_000);
    const answer = (await hub.receive("slack", slack.dm("U0ASKBOT", ANSWER, { bot: true, thread }))).items[0]!;
    await hub.idle();
    expect(answer.delivery).toBe("record");
    await settle(hub);
    expect(listChannelCardsForObject(db, answer.objectKey)).toHaveLength(1);
    expect(messageEvents()).toHaveLength(1);
  });
});

describe("a bot message that nobody asked for", () => {
  it("is only recorded", async () => {
    const { hub } = setup();
    const item = (await hub.receive("slack", slack.dm("U0CALBOT", "", { bot: true, blocks: [{ type: "markdown", text: "Standup in 10 minutes" }] }))).items[0]!;
    await hub.idle();
    expect(item).toMatchObject({ delivery: "record", cardId: null });
    expect(getEvent(db, item.seq!)!.payload).not.toHaveProperty("answersAsk");
    expect(getEvent(db, item.seq!)!.payload).not.toHaveProperty("answerPending");
    await settle(hub);
    expect(messageEvents()).toEqual([]);
  });

  it("is only recorded when the question was asked more than 30 minutes earlier", async () => {
    const { hub } = setup();
    const thread = await threadRoot(hub);
    await leadAsks(hub, thread);
    later(ASK_ANSWER_WINDOW_MS + 60_000);
    const item = (await hub.receive("slack", slack.dm("U0ASKBOT", ANSWER, { bot: true, thread }))).items[0]!;
    await hub.idle();
    expect(item).toMatchObject({ delivery: "record", cardId: null });
    await settle(hub);
    expect(listChannelCardsForObject(db, item.objectKey)).toEqual([]);
    expect(messageEvents()).toEqual([]);
  });

  it("is only recorded in a DM thread where nobody asked anything, even if the user asked in another thread", async () => {
    const { hub } = setup();
    const thread = await threadRoot(hub);
    await leadAsks(hub, thread);
    const item = (await hub.receive("slack", slack.dm("U0ASKBOT", "Daily digest: 3 new datasets", { bot: true }))).items[0]!;
    await hub.idle();
    expect(item).toMatchObject({ delivery: "record", cardId: null });
    await settle(hub);
    expect(listChannelCardsForObject(db, item.objectKey)).toEqual([]);
    expect(messageEvents()).toEqual([]);
  });
});

describe("whether a bot message answers a question (inbound.ts, the decision boundary)", () => {
  const at = "2026-11-25T02:10:00.000Z";
  const asked = (minutesBefore: number, text = QUESTION) => ({ at: new Date(Date.parse(at) - minutesBefore * 60_000).toISOString(), text });
  const base = { bot: true, text: ANSWER, at, audience: "direct" as const, senderName: "Ask Bot", asks: [asked(1)] };

  it.each([
    ["a bot answer in a DM after a question", base, true],
    ["a person's message", { ...base, bot: false }, false],
    ["an empty placeholder", { ...base, text: "  " }, false],
    ["an assistant placeholder", { ...base, text: "Ask Bot (Assistant) is thinking…" }, false],
    ["a bot status line", { ...base, text: "_Thinking..._" }, false],
    ["no question", { ...base, asks: [] }, false],
    ["a question 31 minutes earlier", { ...base, asks: [asked(31)] }, false],
    ["a question after the message", { ...base, asks: [asked(-1)] }, false],
    ["a channel thread question that does not mention the bot", { ...base, audience: "channel" as const }, false],
    ["a channel thread question that mentions the bot", { ...base, audience: "channel" as const, asks: [asked(1, `@Ask Bot ${QUESTION}`)] }, true],
  ])("%s", (_name, input, expected) => {
    expect(answersOwnerAsk(input)).toBe(expected);
  });
});
