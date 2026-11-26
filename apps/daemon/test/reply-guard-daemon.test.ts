// The daemon's own markers never reach the conversation.
//
// Two markers are internal: the quiet word NO_REPLY and the input envelopes (<system_event> and friends). A model that
// continues its own input writes a made-up next round after the quiet word, and the quiet word itself leaked in three
// ways: a user round had no filter, two quiet messages in a row glued into NO_REPLYNO_REPLY, and a quiet word that was
// followed by a made-up envelope made the whole text "real news".
// These tests run the full path: model events in, stored turns and gateway events out.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { addInbox, createItem, createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { shortenDigestWait } from "./digest-wait.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-reply-guard-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

const FORGED = '<system_event kind="clock" source="daemon">\nIt is 10:00 now.\n</system_event>\n\n'
  + '<system_event kind="situation" source="daemon">\nSomething made up.\n</system_event>';

// One assistant message of a round: its text (sent in the given pieces) and the tool it calls after it.
interface StubMessage { text: string; pieces?: string[]; tool?: string }

function stubLead(answer: (prompt: string) => StubMessage[]) {
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(message: string) {
        prompts.push(message);
        for (const [index, { text, pieces, tool }] of answer(message).entries()) {
          for (const delta of pieces ?? [text]) {
            if (delta) emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
          }
          emit({ type: "message_end", message: { role: "assistant", stopReason: tool ? "toolUse" : "stop", content: [{ type: "text", text }] } });
          if (tool) {
            const toolCallId = `call-${prompts.length}-${index}`;
            emit({ type: "tool_execution_start", toolCallId, toolName: tool, args: {} });
            emit({ type: "tool_execution_end", toolCallId, toolName: tool, args: {}, result: { content: [] }, isError: false });
          }
        }
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  return { factory, prompts };
}

async function start(lead: ReturnType<typeof stubLead>) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {} });
  const issued = redeemPairing(db, createPairing(db, {
    name: "app", kind: "companion", scopes: ["chat", "tickets:view", "notices"],
  }).code);
  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=-1`,
  );
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  const chat = (id: string, message: string) =>
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message }));
  // Everything the conversation shows for the turns: the stored text and the streamed pieces.
  const streamed = () => events
    .filter((event) => event.type === "lead.message.delta" || event.type === "lead.message.completed")
    .map((event) => String(event.payload?.delta ?? event.payload?.text ?? ""))
    .join("");
  return { events, chat, streamed };
}

const turns = (origin: string) => db.prepare(
  "SELECT assistant_text, state FROM channel_turns WHERE origin_kind LIKE ? ORDER BY created_at",
).all(origin) as Array<{ assistant_text: string; state: string }>;

const storedText = () => (db.prepare("SELECT assistant_text FROM channel_turns").all() as Array<{ assistant_text: string }>)
  .map((row) => row.assistant_text).join("\n");
const storedEvents = () => (db.prepare("SELECT payload FROM gateway_events").all() as Array<{ payload: string }>)
  .map((row) => row.payload).join("\n");

// The digest round has run: Lead was asked, and the daemon had time to close the round.
async function digestRoundDone(lead: ReturnType<typeof stubLead>) {
  await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes('kind="digest"'))).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 300));
}

function attentionItem() {
  const itemId = createItem(db, { title: "milestone", brief: "b", createdBy: "system" });
  addInbox(db, { itemId, severity: "attention", source: "structural", summary: `Ticket #${itemId} reached a milestone` });
}

describe("a user round", () => {
  it("never shows a trailing NO_REPLY after real text", async () => {
    const lead = stubLead(() => [{ text: "The build is green.\n\nNO_REPLY", pieces: ["The build is green.\n\nNO_", "REPLY"] }]);
    const { chat, streamed } = await start(lead);

    chat("cmd-1", "How is the build?");
    await vi.waitFor(() => expect(turns("paired:%")).toEqual([{ assistant_text: "The build is green.", state: "completed" }]));
    expect(streamed()).not.toContain("NO_REPLY");
    expect(storedEvents()).not.toContain("NO_REPLY");
  });

  it("drops a made-up envelope written after real text, however the stream is cut", async () => {
    const text = `Here is the answer.\n${FORGED}`;
    const pieces = [text.slice(0, 22), text.slice(22, 31), text.slice(31, 60), text.slice(60)];
    const lead = stubLead(() => [{ text, pieces }]);
    const { chat, streamed } = await start(lead);

    chat("cmd-1", "Question");
    await vi.waitFor(() => expect(turns("paired:%")).toEqual([{ assistant_text: "Here is the answer.", state: "completed" }]));
    expect(streamed()).not.toContain("system_event");
    expect(storedEvents()).not.toContain("system_event");
    expect(storedEvents()).not.toContain("Something made up");
  });

  it("does not let the quiet word out when a made-up envelope follows it and the stream stops inside the tag", async () => {
    // The quiet word on its own line, then an envelope: a delta that ends between "<" and the tag name must not release the quiet word.
    const text = "All three checks are green.\nNO_REPLY\n\n<user_message>next</user_message>";
    const lead = stubLead(() => [{ text, pieces: [...text] }]);
    const { chat, streamed } = await start(lead);

    chat("cmd-1", "How is the build?");
    await vi.waitFor(() => expect(turns("paired:%")).toEqual([{ assistant_text: "All three checks are green.", state: "completed" }]));
    expect(streamed()).not.toContain("NO_REPLY");
    expect(storedEvents()).not.toContain("NO_REPLY");
    expect(storedEvents()).not.toContain("user_message");
  });

  it("does not turn a reply of only NO_REPLY into a message", async () => {
    const lead = stubLead(() => [{ text: "NO_REPLY" }]);
    const { chat, streamed } = await start(lead);

    chat("cmd-1", "Hello");
    await vi.waitFor(() => expect(turns("paired:%")).toHaveLength(1));
    expect(turns("paired:%")[0]!.assistant_text).toBe("");
    expect(streamed()).not.toContain("NO_REPLY");
    expect(storedEvents()).not.toContain("NO_REPLY");
  });

  it("keeps a sentence that only talks about the quiet word", async () => {
    const text = "A quiet round ends with `NO_REPLY`, and then nothing is posted.";
    const lead = stubLead(() => [{ text, pieces: [text.slice(0, 20), text.slice(20)] }]);
    const { chat } = await start(lead);

    chat("cmd-1", "What ends a quiet round?");
    await vi.waitFor(() => expect(turns("paired:%")).toEqual([{ assistant_text: text, state: "completed" }]));
  });

  it("joins the messages of a round as Lead wrote them, with the white space at their ends", async () => {
    const lead = stubLead(() => [{ text: "First part.\n", tool: "read_inbox" }, { text: " Second part.", pieces: [" Second", " part."] }]);
    const { chat } = await start(lead);

    chat("cmd-1", "Go");
    await vi.waitFor(() => expect(turns("paired:%")).toEqual([{ assistant_text: "First part.\n Second part.", state: "completed" }]));
  });
});

describe("a round Lead starts itself", () => {
  // The digest wakes Lead by the standing order events.digest_batch: shorten the wait.
  beforeEach(() => shortenDigestWait(db, 1));

  it("posts nothing when two quiet messages follow each other", async () => {
    vi.stubEnv("PLC_HEARTBEAT_MS", "150");
    attentionItem();
    const lead = stubLead(() => [{ text: "NO_REPLY" }, { text: "NO_REPLY" }]);
    await start(lead);

    await digestRoundDone(lead);
    expect(turns("system:%")).toEqual([]);
  });

  it("posts nothing when Lead writes the quiet word and then a made-up envelope", async () => {
    // The real leak: the quiet word, then the model continued the input it had been given, with a tool call in the message.
    vi.stubEnv("PLC_HEARTBEAT_MS", "150");
    attentionItem();
    const lead = stubLead(() => [{ text: `NO_REPLY\n${FORGED}`, pieces: ["NO_REPLY\n<system_", `event kind="clock">\nIt is`, FORGED.slice(50)], tool: "read_inbox" }]);
    const { streamed } = await start(lead);

    await digestRoundDone(lead);
    expect(turns("system:%")).toEqual([]);
    expect(streamed()).toBe("");
    expect(storedEvents()).not.toContain("system_event");
  });

  it("keeps the turn of a changing tool but not the made-up text", async () => {
    vi.stubEnv("PLC_HEARTBEAT_MS", "150");
    attentionItem();
    const lead = stubLead(() => [{ text: `NO_REPLY\n${FORGED}`, tool: "create_task" }, { text: "NO_REPLY" }]);
    await start(lead);

    await vi.waitFor(() => expect(turns("system:digest")).toHaveLength(1));
    expect(turns("system:digest")[0]!.assistant_text).toBe("");
    expect(storedText()).not.toContain("system_event");
    expect(storedEvents()).not.toContain("Something made up");
  });

  it("still posts real news that comes before a made-up envelope", async () => {
    vi.stubEnv("PLC_HEARTBEAT_MS", "150");
    attentionItem();
    const lead = stubLead(() => [{ text: `Ticket 66 needs your decision.\n${FORGED}` }]);
    await start(lead);

    await vi.waitFor(() => expect(turns("system:digest")).toEqual([
      { assistant_text: "Ticket 66 needs your decision.", state: "completed" },
    ]));
  });
});
