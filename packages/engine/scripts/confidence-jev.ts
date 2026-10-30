// 跑用例时用 Jev 重新打分（confidence-cases.ts 的 --jev）：对一条消息和它的草稿各问一次请求 A 和请求 B，
// 问法和线上一样（judgeChannelIntake、judgeReplyCheck），换掉用例里的假设值。
// 真实用例的原话、前几条消息、草稿和代查结果从线上库只读地取（readLiveCase），不写库。
import { DatabaseSync } from "node:sqlite";
import type { LookupReadRecord, LookupResult, SenderTrust } from "@pi-lead-child/protocol";
import { isSenderTrust } from "@pi-lead-child/protocol";
import { COST_TOPICS, type ConfidenceModelInput } from "../src/channels/confidence-model.js";
import { judgeChannelIntake, type ChannelIntakeInput } from "../src/channels/intake.js";
import { judgeReplyCheck } from "../src/channels/reply-check.js";
import type { SmartModel } from "../src/smart-model/types.js";

/** 用例里指向线上库的位置：消息的 seq（几条连着的消息）、卡、代查。 */
export interface LiveRef {
  seqs: number[];
  // 没开卡（例如判断不用回）时没有。
  cardId?: number;
  lookupId?: number;
}

export interface JevCase {
  message: string;
  recent: ChannelIntakeInput["recent"];
  senderTrust: SenderTrust;
  laneLabel: string;
  // 要核对的结果。不是代查的草稿：answer 和 replyDraft 都是草稿。
  result: LookupResult;
  reads: LookupReadRecord[];
}

type Scores = ConfidenceModelInput["scores"];

const MESSAGE_KINDS = ["slack.dm.received", "slack.channel.message", "slack.thread.message", "slack.mention.received", "slack.self.reply"];

const parse = (text: unknown): Record<string, unknown> => {
  try {
    const value = JSON.parse(String(text)) as unknown;
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

// target_repo 是选择题，至少要两个选项（候选仓库加 none）。问题之间互相独立，候选仓库也不进状态文本，
// 所以多一个占位的候选不影响别的回答。
const PLACEHOLDER_CANDIDATE = { repo: "placeholder/none", root: "/nonexistent/placeholder", github: null };

/** 不是代查的草稿，包成一个结果给请求 B。 */
export function draftResult(draft: string): LookupResult {
  return { found: "yes", answer: draft, sources: [], checked: [], caveats: [], replyDraft: draft };
}

/** 从线上库只读地取一个真实用例。 */
export function readLiveCase(dbPath: string, ref: LiveRef): JevCase {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const events = ref.seqs.map((seq) => db.prepare("SELECT seq, entity_key, payload FROM events WHERE seq = ?").get(seq) as
      { seq: number; entity_key: string; payload: string } | undefined);
    if (events.some((event) => !event)) throw new Error(`events ${ref.seqs.join(",")} 有找不到的`);
    const first = parse(events[0]!.payload);
    const message = events.map((event) => String(parse(event!.payload).text ?? "")).filter(Boolean).join("\n");
    const placeholders = MESSAGE_KINDS.map(() => "?").join(",");
    const earlier = db.prepare(
      `SELECT kind, payload FROM events WHERE entity_key = ? AND seq < ? AND kind IN (${placeholders}) ORDER BY seq DESC LIMIT 5`,
    ).all(events[0]!.entity_key, events[0]!.seq, ...MESSAGE_KINDS) as Array<{ kind: string; payload: string }>;
    const recent = earlier.reverse()
      .map((row) => ({ role: row.kind === "slack.self.reply" ? "me" as const : "them" as const, text: String(parse(row.payload).text ?? "") }))
      .filter((entry) => entry.text.trim());
    const card = ref.cardId === undefined ? undefined
      : db.prepare("SELECT draft FROM channel_cards WHERE id = ?").get(ref.cardId) as { draft: string | null } | undefined;
    const draft = String(parse(card?.draft).text ?? "");
    let result = draftResult(draft);
    let reads: LookupReadRecord[] = [];
    if (ref.lookupId !== undefined) {
      const lookup = db.prepare("SELECT result, reads FROM channel_lookups WHERE id = ?").get(ref.lookupId) as
        { result: string | null; reads: string } | undefined;
      if (lookup?.result) result = JSON.parse(lookup.result) as LookupResult;
      if (lookup?.reads) reads = JSON.parse(lookup.reads) as LookupReadRecord[];
    }
    const sender = (typeof first.sender === "object" && first.sender !== null ? first.sender : {}) as Record<string, unknown>;
    return {
      message, recent, result, reads,
      senderTrust: isSenderTrust(sender.trust) ? sender.trust : "unknown",
      laneLabel: String(first.laneLabel ?? "对话"),
    };
  } finally {
    db.close();
  }
}

/**
 * 问请求 A 和请求 B，返回问到的分数、请求 A 认出的意图和问到了哪几项。问不成的项不返回，用例里原来的值不动。
 * 意图和收尾的种类来自请求 A 第 4 版（ask_kind、closing_kind），和线上的链路一样；用例里人工标的意图只用来对照。
 */
export async function rescoreWithModel(input: JevCase, model: SmartModel): Promise<{
  scores: Partial<Scores>; intent: ConfidenceModelInput["intent"] | null; answered: string[]; errors: string[];
}> {
  const scores: Partial<Scores> = {};
  let intent: ConfidenceModelInput["intent"] | null = null;
  const answered: string[] = [];
  const errors: string[] = [];
  const intake = await judgeChannelIntake({
    intake: { text: input.message, recent: input.recent, senderTrust: input.senderTrust, laneLabel: input.laneLabel, businessMap: null, candidates: [PLACEHOLDER_CANDIDATE] },
    model,
  });
  if (intake.status === "answered") {
    if (intake.askKind) intent = { kind: intake.askKind, closing: intake.askKind === "closing" ? intake.closing : null };
    scores.askConfidence = intake.askConfidence;
    scores.sensitiveQueries = { ...intake.sensitive };
    scores.topics = Object.fromEntries(COST_TOPICS.filter((topic) => typeof intake.topics[topic] === "number").map((topic) => [topic, intake.topics[topic]!]));
    answered.push("askConfidence", "sensitiveQueries", "topics");
    if (intake.needsReply !== null) {
      scores.needsReply = intake.needsReply;
      answered.push("needsReply");
    }
  } else {
    errors.push(`请求 A：${intake.error ?? "没有回答"}`);
  }
  if (input.result.replyDraft.trim() || input.result.answer.trim()) {
    const check = await judgeReplyCheck({ question: input.message, result: input.result, reads: input.reads, model });
    if (check.ok) {
      scores.fulfills = check.fulfillsRequest;
      scores.grounded = check.grounded;
      scores.draftCommits = check.draftCommits;
      scores.draftOvershares = check.draftOvershares;
      answered.push("fulfills", "grounded", "draftCommits", "draftOvershares");
    } else {
      errors.push(`请求 B：${check.error ?? "没有回答"}`);
    }
  } else {
    errors.push("请求 B：没有草稿");
  }
  return { scores, intent, answered, errors };
}
