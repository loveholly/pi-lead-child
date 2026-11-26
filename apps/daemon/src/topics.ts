// Topics (protocol's topics.ts, user 2026-11-25): the live sessions of the topics, and their turns.
//
// A topic is a second Lead session. It runs in this process, apart from Lead's main session: it has its own session
// file, its own turn state and its own record of what the turn read (turn origin). The main session's scheduler,
// hand-off packages and event input do not see it, so the main conversation handles events while a topic answers.
//
//   - A session is built when a topic first needs one, and released after it was idle for a while. At most a few are
//     alive at a time; the one that was idle longest goes first. Releasing a session loses nothing: the session file
//     and the turns are on disk.
//   - A topic answers one message at a time. A message that arrives while it answers waits in a queue (state queued).
//   - The first input of a new session carries the topic's background (lead's topic.ts). It is built from stored rows.
//   - Events to the clients use the lead.* types with topicId in the payload; only connections that declared
//     include=topics get them (protocol's gatewayEventOptIn). A turn that failed sends snapshot.required (topics).
//   - A message can carry images and files, as in the main conversation: the same tables (chat_images, chat_files,
//     keyed by the topic turn's id), the same folder for the copies that the session reads (chat-files.ts), the same
//     envelope (leadUserMessage). They are read from the tables when the turn runs, so a queued turn keeps them.
//   - Nothing here writes channel_turns or the event log of the main conversation.
import { join } from "node:path";
import { localIso } from "@pi-lead-child/core";
import { assistantMessageText, PairedCommandError, projectToolEvent } from "@pi-lead-child/gateway";
import {
  isExternalTextTool, leadSystemEvent, leadUserMessage, topicBackgroundText, TOPIC_CARRIED_TURNS, TOPIC_OPENING_REQUEST,
  withExternalContent, type LeadEngine, type LeadTurnOrigin, type LeadUserFile,
} from "@pi-lead-child/lead";
import {
  createReplyStreamGuard, redactSecretText, TOPIC_OPENING_ORIGIN, TOPIC_TURN_ERRORS, TOPIC_USER_ORIGIN_SUFFIX, TOPICS_RESOURCE, type ReplyStreamGuard, type SendTopicMessageResponse,
} from "@pi-lead-child/protocol";
import {
  appendTopicTurnDelta, completeTopicTurn, createTopicTurn, failTopicTurn, getTopic, getTopicTurn, insertChatFiles,
  insertChatImages, listChatImageRefs, listTopicTurns, listTurnChatFiles, listTurnChatImages,
  listUnfinishedTopicTurns, recentMainDialogue, startTopicTurn, topicOpeningText,
  type ChatFileData, type ChatImageData, type Db, type PublishGatewayEventInput, type TopicRow, type TopicTurnRow,
} from "@pi-lead-child/store";

import { removeChatTurnFiles, writeChatTurnFiles } from "./chat-files.js";


/** The folder that holds one topic's session file. */
export function topicSessionDir(dataDir: string, topicId: number): string {
  return join(dataDir, "topic-sessions", String(topicId));
}

export interface TopicSessionRequest {
  topicId: number;
  sessionDir: string;
  // The topic's own turn state: Lead's tools read it for authority and for the external-content rules.
  currentTurnId: () => string | null;
  turnOrigin: () => LeadTurnOrigin;
}

export interface TopicRuntimeOptions {
  db: Db;
  dataDir: string;
  log: (line: string) => void;
  // Build a Lead session for a topic: the daemon's shared options, the topic's folder and the topic's turn state.
  createSession: (request: TopicSessionRequest) => Promise<{
    session: LeadEngine; modelName?: string; isFresh?: () => boolean; switchModel?: (spec: string) => Promise<void>;
  }>;
  // The model of Lead's main conversation now (provider/id with an optional effort suffix). A topic without a model
  // of its own follows it. null: not known; then the session keeps the model it was built with.
  defaultModel?: () => string | null;
  publish: (event: PublishGatewayEventInput) => void;
  // A session that nobody used for this long is released. Default 20 minutes.
  idleMs?: number;
  // How many sessions stay alive. Default 3.
  maxLive?: number;
}

interface RunningTurn {
  turn: TopicTurnRow;
  assistantText: string;
  // The text of the model message that is streaming now (one turn can hold several messages, with tools between).
  messageText: string;
  // Keeps the daemon's own markers (the quiet word, made-up input envelopes) out of what the topic shows.
  guard: ReplyStreamGuard;
  error: string | null;
  ranTools: boolean;
}

interface LiveTopic {
  topicId: number;
  session: LeadEngine;
  unsubscribe: () => void;
  // The background was given to this session (or the session came back from its file with its history).
  primed: boolean;
  origin: LeadTurnOrigin;
  running: RunningTurn | null;
  lastUsedAt: number;
  // The model the session uses now, and how to change it (not there for a test stand-in).
  model: string | null;
  switchModel: ((spec: string) => Promise<void>) | null;
}

const FRESH_ORIGIN: LeadTurnOrigin = { external: false, timer: null };

export class TopicRuntime {
  readonly #options: TopicRuntimeOptions;
  readonly #live = new Map<number, LiveTopic>();
  readonly #building = new Map<number, Promise<LiveTopic>>();
  // The topic that is answering now, and the turns that wait behind it (oldest first).
  readonly #busy = new Set<number>();
  readonly #queues = new Map<number, string[]>();
  readonly #sweep: NodeJS.Timeout;
  #disposed = false;

  constructor(options: TopicRuntimeOptions) {
    this.#options = options;
    this.#sweep = setInterval(() => this.#releaseIdle(), 60_000);
    this.#sweep.unref();
  }

  /** Turns that a daemon stop left unfinished: fail them, so no reply shows as still being written. */
  failUnfinished(): number {
    const turns = listUnfinishedTopicTurns(this.#options.db);
    for (const turn of turns) failTopicTurn(this.#options.db, turn.id, TOPIC_TURN_ERRORS.restarted);
    if (turns.length) this.#changed();
    return turns.length;
  }

  busy(topicId: number): boolean {
    return this.#busy.has(topicId);
  }

  /** A message from the user in a topic (POST /v1/topics/:id/messages). Returns before the model answers. */
  send(command: {
    topicId: number; text: string; bindingId: number; bindingKind: string; bindingName: string;
    // Checked and decoded by the gateway. A message with an image or a file can have no text.
    images?: readonly ChatImageData[]; files?: readonly ChatFileData[];
  }): SendTopicMessageResponse {
    const { db, dataDir } = this.#options;
    const topic = getTopic(db, command.topicId);
    if (!topic) throw new PairedCommandError("not_found", `topic ${command.topicId} not found`);
    if (topic.state !== "open") throw new PairedCommandError("conflict", `topic ${command.topicId} is closed`);
    const text = command.text.trim();
    const images = command.images ?? [];
    const files = command.files ?? [];
    if (!text && !images.length && !files.length) throw new PairedCommandError("invalid_request", "the message is empty");
    const waits = this.#busy.has(topic.id);
    // The images and the files are stored with the turn, in one transaction. The copies of the files that the session
    // reads are written in it too: when they cannot be written, the message is refused and nothing is kept.
    const turn = db.transaction(() => {
      const created = createTopicTurn(db, {
        topicId: topic.id,
        originKind: `paired:${command.bindingKind}${TOPIC_USER_ORIGIN_SUFFIX}`,
        originBindingId: command.bindingId,
        userText: text,
        state: waits ? "queued" : "streaming",
      });
      if (images.length) insertChatImages(db, created.id, images);
      if (files.length) {
        const stored = insertChatFiles(db, created.id, files).map((ref, index) => ({
          id: ref.id, turnId: created.id, name: ref.name, diskName: ref.diskName, mimeType: ref.mimeType, data: files[index]!.data,
        }));
        try {
          writeChatTurnFiles(dataDir, created.id, stored);
        } catch (error) {
          removeChatTurnFiles(dataDir, created.id);
          this.#log(topic.id, `could not write the files of a new message: ${message(error)}`);
          throw new PairedCommandError("invalid_request", "could not save the attached files");
        }
      }
      return created;
    })();
    this.#vias.set(turn.id, command.bindingName);
    // The other devices show the text from the turn event; the images and the files come with the topic's turns.
    if (images.length || files.length) this.#changed();
    if (waits) {
      this.#queue(topic.id).push(turn.id);
      this.#publishStarted(turn, "queued");
    } else {
      this.#start(topic.id, turn.id);
    }
    return { topicId: topic.id, turnId: turn.id, state: waits ? "queued" : "streaming" };
  }

  /** The topic was opened without an opening: its session writes one as the first turn. */
  generateOpening(topicId: number, _options: { bindingId: number | null }): void {
    const topic = getTopic(this.#options.db, topicId);
    if (!topic || topic.state !== "open") return;
    const waits = this.#busy.has(topicId);
    const turn = createTopicTurn(this.#options.db, {
      topicId, originKind: TOPIC_OPENING_ORIGIN, state: waits ? "queued" : "streaming",
    });
    if (waits) this.#queue(topicId).push(turn.id);
    else this.#start(topicId, turn.id);
  }

  /** Stop the reply that a topic is writing. The turn ends with what was written. */
  stop(topicId: number): boolean {
    const live = this.#live.get(topicId);
    if (!live?.running) return false;
    void live.session.abort?.().catch((error: unknown) => this.#log(topicId, `stop failed: ${message(error)}`));
    return true;
  }

  /** The topic was closed: its session is released when it is not answering. */
  closed(topicId: number): void {
    if (!this.#busy.has(topicId)) this.#release(topicId);
  }

  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#sweep);
    for (const topicId of [...this.#live.keys()]) this.#release(topicId);
  }

  // ── One turn ────────────────────────────────────────────────────────────────

  readonly #vias = new Map<string, string>();

  #queue(topicId: number): string[] {
    let queue = this.#queues.get(topicId);
    if (!queue) {
      queue = [];
      this.#queues.set(topicId, queue);
    }
    return queue;
  }

  #start(topicId: number, turnId: string): void {
    this.#busy.add(topicId);
    void this.#run(topicId, turnId)
      .catch((error: unknown) => this.#log(topicId, `turn ${turnId} ended with an error outside the run: ${message(error)}`))
      .finally(() => {
        this.#vias.delete(turnId);
        const next = this.#queue(topicId).shift();
        if (next && !this.#disposed) {
          startTopicTurn(this.#options.db, next);
          this.#start(topicId, next);
        } else {
          this.#busy.delete(topicId);
          this.#queues.delete(topicId);
          const topic = getTopic(this.#options.db, topicId);
          if (topic?.state === "closed") this.#release(topicId);
        }
      });
  }

  async #run(topicId: number, turnId: string): Promise<void> {
    const { db } = this.#options;
    const turn = getTopicTurn(db, turnId);
    const topic = getTopic(db, topicId);
    if (!turn || !topic) return;
    const running: RunningTurn = { turn, assistantText: "", messageText: "", guard: createReplyStreamGuard(), error: null, ranTools: false };
    let live: LiveTopic;
    try {
      live = await this.#ensure(topicId);
    } catch (error) {
      this.#log(topicId, `could not start the session: ${message(error)}`);
      this.#fail(running, TOPIC_TURN_ERRORS.sessionUnavailable);
      return;
    }
    // The topic's own model (topic.set_model), or the main conversation's when it has none. Checked at every turn, so a
    // change takes effect with the next message, and a topic without its own model follows the main conversation.
    const wanted = topic.model ?? this.#options.defaultModel?.() ?? null;
    if (wanted && wanted !== live.model && live.switchModel) {
      try {
        await live.switchModel(wanted);
        live.model = wanted;
        this.#log(topicId, `model ${wanted}`);
      } catch (error) {
        this.#log(topicId, `could not switch to ${wanted}: ${message(error)}`);
        this.#fail(running, `${TOPIC_TURN_ERRORS.modelUnavailable}: ${wanted}`);
        return;
      }
    }
    live.origin = FRESH_ORIGIN;
    live.running = running;
    live.lastUsedAt = Date.now();
    this.#publishStarted(turn, "started");
    const isOpening = turn.origin_kind === TOPIC_OPENING_ORIGIN;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const clock = leadSystemEvent("clock", `当前时间：${localIso(new Date())}，时区 ${tz}`);
    const background = live.primed ? "" : leadSystemEvent("context", this.#background(topic, turn));
    // What the user sent with the message, read from the tables by the turn's id (a queued turn has them too).
    const images = isOpening ? [] : listTurnChatImages(db, turn.id).map((image) => ({
      type: "image" as const, data: image.data.toString("base64"), mimeType: image.mimeType,
    }));
    const imageIds = isOpening ? [] : (listChatImageRefs(db, [turn.id]).get(turn.id) ?? []).map((image) => image.id);
    const files = isOpening ? [] : this.#turnFiles(topicId, turn.id);
    const body = isOpening
      ? leadSystemEvent("system", TOPIC_OPENING_REQUEST)
      : leadUserMessage({
        via: this.#vias.get(turn.id) ?? "Companion", channel: turn.origin_kind,
        ...(imageIds.length ? { imageIds } : {}), ...(files.length ? { files } : {}),
      }, turn.user_text);
    const full = [clock, background, body].filter(Boolean).join("\n\n");
    try {
      if (images.length) await live.session.prompt(full, { images });
      else await live.session.prompt(full);
      live.primed = true;
    } catch (error) {
      running.error ??= message(error);
    } finally {
      live.running = null;
      live.lastUsedAt = Date.now();
    }
    if (running.error && !running.assistantText.trim()) {
      this.#fail(running, running.error);
    } else if (!running.assistantText.trim()) {
      this.#fail(running, TOPIC_TURN_ERRORS.emptyReply);
    } else {
      completeTopicTurn(db, turn.id);
      this.#options.publish({
        type: "lead.message.completed", requiredScope: "chat", turnId: turn.id,
        payload: { messageId: `msg_${turn.id}`, text: running.assistantText, topicId },
      });
      // The list shows the last turn of each topic (a device marks a new reply from it).
      this.#changed();
    }
  }

  // The files of a turn, as the list that the session reads (envelope.ts). The copies are in the data directory's
  // chat-files/<turn>/; a copy that is missing is written again from the table.
  #turnFiles(topicId: number, turnId: string): LeadUserFile[] {
    const files = listTurnChatFiles(this.#options.db, turnId);
    if (!files.length) return [];
    try {
      return writeChatTurnFiles(this.#options.dataDir, turnId, files);
    } catch (error) {
      this.#log(topicId, `could not write the files of turn ${turnId}: ${message(error)}`);
      return [];
    }
  }

  #fail(running: RunningTurn, error: string): void {
    failTopicTurn(this.#options.db, running.turn.id, redactSecretText(error).slice(0, 2000));
    this.#changed();
  }

  // What a new session reads first (lead's topic.ts). Earlier turns of the topic are included only when there are any:
  // then the session file was lost and the session starts again.
  #background(topic: TopicRow, current: TopicTurnRow): string {
    const { db } = this.#options;
    const earlier = listTopicTurns(db, topic.id)
      .filter((turn) => turn.id !== current.id && turn.state === "completed" && turn.origin_kind !== TOPIC_OPENING_ORIGIN)
      .slice(-TOPIC_CARRIED_TURNS);
    return topicBackgroundText({
      id: topic.id,
      title: topic.title,
      openedBy: topic.opened_by,
      quote: topic.origin_quote && topic.origin_role ? { text: topic.origin_quote, role: topic.origin_role } : null,
      opening: current.origin_kind === TOPIC_OPENING_ORIGIN ? null : topicOpeningText(db, topic.id),
      mainTurns: recentMainDialogue(db, { limit: TOPIC_CARRIED_TURNS, upTo: topic.origin_turn_id }),
      topicTurns: earlier.map((turn) => ({ userText: turn.user_text, assistantText: turn.assistant_text })),
    });
  }

  // ── Sessions ────────────────────────────────────────────────────────────────

  async #ensure(topicId: number): Promise<LiveTopic> {
    const existing = this.#live.get(topicId);
    if (existing) return existing;
    const building = this.#building.get(topicId);
    if (building) return building;
    const build = this.#build(topicId).finally(() => this.#building.delete(topicId));
    this.#building.set(topicId, build);
    return build;
  }

  async #build(topicId: number): Promise<LiveTopic> {
    this.#makeRoom(topicId);
    const slot: { live: LiveTopic | null } = { live: null };
    const built = await this.#options.createSession({
      topicId,
      sessionDir: topicSessionDir(this.#options.dataDir, topicId),
      currentTurnId: () => slot.live?.running?.turn.id ?? null,
      turnOrigin: () => slot.live?.origin ?? FRESH_ORIGIN,
    });
    const live: LiveTopic = {
      topicId,
      session: built.session,
      unsubscribe: () => {},
      // A session that came back from its file has its history: it needs no background. A test stand-in does not say.
      primed: built.isFresh ? !built.isFresh() : false,
      origin: FRESH_ORIGIN,
      running: null,
      lastUsedAt: Date.now(),
      model: built.modelName ?? null,
      switchModel: built.switchModel ?? null,
    };
    live.unsubscribe = built.session.subscribe((event: any) => this.#onEvent(live, event));
    slot.live = live;
    this.#live.set(topicId, live);
    this.#log(topicId, `session ready (${built.session.sessionId}, ${live.primed ? "continued" : "new"})`);
    return live;
  }

  #onEvent(live: LiveTopic, event: any): void {
    const running = live.running;
    if (!running) return;
    const { publish } = this.#options;
    const turnId = running.turn.id;
    const topicId = live.topicId;
    if (event.type === "message_start" && event.message?.role === "assistant") running.messageText = "";
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const delta = String(event.assistantMessageEvent.delta ?? "");
      running.messageText += delta;
      this.#feed(running, topicId, (guard) => guard.push(delta));
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      // A provider that does not stream gives the text only here: send what the deltas did not carry.
      const full = assistantMessageText(event.message);
      if (full.startsWith(running.messageText) && full.length > running.messageText.length) {
        const rest = full.slice(running.messageText.length);
        running.messageText = full;
        this.#feed(running, topicId, (guard) => guard.push(rest));
      }
      this.#feed(running, topicId, (guard) => guard.end());
      if (event.message.stopReason === "error") {
        running.error = String(event.message.errorMessage || TOPIC_TURN_ERRORS.emptyReply);
        this.#log(topicId, `model error: ${redactSecretText(running.error).slice(0, 200)}`);
      } else if (event.message.stopReason !== "aborted") {
        running.error = null;
      }
    }
    if (event.type === "tool_execution_start") {
      // A tool whose output is external content (lead's turn-origin.ts): this turn has read external content.
      if (isExternalTextTool(event.toolName)) live.origin = withExternalContent(live.origin, { via: "tool", tool: event.toolName });
    }
    const toolTypes: Record<string, "lead.tool.started" | "lead.tool.updated" | "lead.tool.completed" | "lead.tool.failed"> = {
      tool_execution_start: "lead.tool.started",
      tool_execution_update: "lead.tool.updated",
      tool_execution_end: event.isError ? "lead.tool.failed" : "lead.tool.completed",
    };
    const toolType = toolTypes[event.type as string];
    if (toolType) {
      running.ranTools = true;
      publish({
        type: toolType, requiredScope: "chat", turnId,
        payload: { ...projectToolEvent(event), textOffset: running.assistantText.length, topicId },
      });
    }
  }

  // Text goes through the guard.
  #feed(running: RunningTurn, topicId: number, next: (guard: ReplyStreamGuard) => string): void {
    const piece = next(running.guard);
    if (piece) this.#text(running, topicId, piece);
  }

  #text(running: RunningTurn, topicId: number, delta: string): void {
    if (!delta) return;
    running.assistantText += delta;
    appendTopicTurnDelta(this.#options.db, running.turn.id, delta);
    this.#options.publish({
      type: "lead.message.delta", requiredScope: "chat", turnId: running.turn.id,
      payload: { messageId: `msg_${running.turn.id}`, delta, topicId },
    });
  }

  #publishStarted(turn: TopicTurnRow, mode: "started" | "queued"): void {
    this.#options.publish({
      type: "lead.turn.started", requiredScope: "chat", turnId: turn.id,
      payload: {
        messageId: `msg_${turn.id}`, commandId: null, originKind: turn.origin_kind, mode, topicId: turn.topic_id,
        ...(turn.user_text.trim() ? { userText: turn.user_text } : {}),
      },
    });
  }

  #changed(): void {
    this.#options.publish({ type: "snapshot.required", requiredScope: "chat", payload: { resource: TOPICS_RESOURCE } });
  }

  // Keep the number of live sessions under the limit: release the idle one that was used longest ago.
  #makeRoom(forTopic: number): void {
    const max = this.#options.maxLive ?? 3;
    while (this.#live.size >= max) {
      const idle = [...this.#live.values()]
        .filter((live) => live.topicId !== forTopic && !this.#busy.has(live.topicId))
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!idle) return;
      this.#release(idle.topicId);
    }
  }

  #releaseIdle(): void {
    const idleMs = this.#options.idleMs ?? 20 * 60_000;
    for (const live of [...this.#live.values()]) {
      if (!this.#busy.has(live.topicId) && Date.now() - live.lastUsedAt > idleMs) this.#release(live.topicId);
    }
  }

  #release(topicId: number): void {
    const live = this.#live.get(topicId);
    if (!live) return;
    this.#live.delete(topicId);
    try {
      live.unsubscribe();
      live.session.dispose();
    } catch (error) {
      this.#log(topicId, `releasing the session failed: ${message(error)}`);
    }
    this.#log(topicId, "session released");
  }

  #log(topicId: number, line: string): void {
    this.#options.log(`[topic ${topicId}] ${line}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
