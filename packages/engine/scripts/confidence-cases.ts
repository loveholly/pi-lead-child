// 跑信心计算模型的用例（设计见 .scratch/confidence-model/design.md）。缺省只读用例文件，不读库、不调模型。
//   node --import tsx packages/engine/scripts/confidence-cases.ts            跑 cases.json 和 my-cases.json，打印结果表
//   ... --only R05,S06                                                        只跑这几个
//   ... --out .scratch/confidence-model/results.md                           另外把结果表和每个用例的明细写进这个文件
//   ... --lock-weight 1                                                       weighted 底线用的指数（缺省 4）
//   ... --jev                                                                 用 Jev 重新打分：真实用例从线上库只读地取原话和草稿，
//                                                                             敏感用例用 jev 字段的原话和草稿。密钥从环境变量 JEV_API_KEY 或 TYPESAFE_API_KEY 读，
//                                                                             可选 JEV_MODEL、JEV_ENDPOINT。对照用例的分数是设定的，不重打。
//   ... --jev --save-jev                                                      把 Jev 打的分存进 jev-scores.json。以后不加 --jev 时
//                                                                             默认用存下的分数（加 --no-jev-cache 不用）。
// 每行：用例、各维度的分数（* 是假设值）、信心、代价档、门槛、结论（hard 底线）、你在 Slack 里实际做了什么、对不对、原因，
// 最后一列是用 weighted 底线的结论。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSenderTrust } from "@pi-lead-child/protocol";
import {
  CONFIDENCE_INTENT_LABELS, CONFIDENCE_MODEL_DEFAULTS, evaluateConfidenceModel,
  type ConfidenceDecision, type ConfidenceModelInput, type ConfidenceModelResult,
} from "../src/channels/confidence-model.js";
import { createJevSmartModel } from "../src/smart-model/jev.js";
import type { SmartModel } from "../src/smart-model/types.js";
import { draftResult, readLiveCase, rescoreWithModel, type JevCase, type LiveRef } from "./confidence-jev.js";

const ROOT = process.cwd();
const DIR = path.join(ROOT, ".scratch", "confidence-model");
// 线上库：只读地打开（readLiveCase）。
const LIVE_DB = path.join(os.homedir(), ".pi-lead-child", "plc.db");
// Jev 打的分（只有分数，没有消息原文）。
const JEV_CACHE = path.join(DIR, "jev-scores.json");

type Actual = "sent_as_is" | "own_reply" | "emoji" | "nothing";
// grounded：「有据」用的是哪一版的题。"current" 是 2026-10-22 以前存的第 2 版；第 3 版上线以后存的都是 "v3"。
// intent：请求 A 第 4 版认出的意图（2026-10-22 以前存的没有）。
interface JevCacheEntry {
  scores: Partial<ConfidenceModelInput["scores"]>; answered: string[]; grounded: "current" | "v3"; intent?: ConfidenceModelInput["intent"];
}

interface CaseFile {
  defaults?: Partial<CaseEntry>;
  cases: CaseEntry[];
}

interface CaseEntry {
  id: string;
  origin?: string;
  title?: string;
  ref?: string;
  quote?: string;
  draft?: boolean | string;
  choice?: string;
  found?: ConfidenceModelInput["found"];
  skip?: boolean;
  scores?: Partial<ConfidenceModelInput["scores"]>;
  facts?: Partial<ConfidenceModelInput["facts"]>;
  calibration?: Partial<ConfidenceModelInput["calibration"]>;
  assumed?: string[];
  note?: string;
  live?: LiveRef;
  jev?: { message: string; draft: string };
  // 对方的意图（人工标注）。用 Jev 打分时按请求 A 第 4 版认出的意图算，人工标的只用来对照。
  intent?: ConfidenceModelInput["intent"];
  // 你在 Slack 里实际做了什么，和一句说明。
  actual?: Actual;
  slack?: string;
}

// 只读仓库里的文件：用例文件可能是别人给的路径。
function insideRoot(file: string): string {
  const resolved = path.resolve(ROOT, file);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) throw new Error(`${file} 不在仓库里`);
  return resolved;
}

function load(file: string): CaseFile {
  const data = JSON.parse(readFileSync(insideRoot(file), "utf8")) as unknown;
  if (typeof data !== "object" || data === null || !Array.isArray((data as CaseFile).cases)) throw new Error(`${file} 没有 cases 数组`);
  for (const entry of (data as CaseFile).cases) {
    if (typeof entry?.id !== "string" || !/^[A-Za-z0-9_-]{1,20}$/.test(entry.id)) throw new Error(`${file} 有一个用例的 id 不对`);
  }
  return data as CaseFile;
}

function toInput(entry: CaseEntry, defaults: Partial<CaseEntry>): ConfidenceModelInput {
  const draft = entry.draft ?? defaults.draft ?? true;
  return {
    intent: entry.intent ?? defaults.intent ?? null,
    draft: typeof draft === "string" ? draft.trim().length > 0 : draft,
    found: entry.found ?? defaults.found ?? "not_needed",
    scores: { ...defaults.scores, ...entry.scores } as ConfidenceModelInput["scores"],
    facts: { ...defaults.facts, ...entry.facts } as ConfidenceModelInput["facts"],
    calibration: { samples: 0, buckets: [], ...defaults.calibration, ...entry.calibration },
  };
}

const DECISION_LABELS: Record<ConfidenceDecision, string> = {
  auto_send: "**代你回**", approve: "**批准并回复**", react: "回表情", remind: "提醒你", refuse: "代你拒绝", ask_user: "问你",
  hand_over: "交给你", skip: "不打扰",
};
const CLOSING_LABELS: Record<string, string> = { they_thank_you: "对方谢你", you_thank_them: "你谢对方", farewell: "告别", remark: "附和或感叹" };
const ACTUAL_LABELS: Record<Actual, string> = { sent_as_is: "照发", own_reply: "自己写", emoji: "回表情", nothing: "没做" };

/** 模型的结论和你实际做的事对得上吗。 */
function verdict(decision: ConfidenceDecision, actual: Actual): { key: string; label: string } {
  if (decision === "react") return actual === "nothing" || actual === "emoji" ? { key: "right", label: "✓" } : { key: "other", label: "你回了文字" };
  if (decision === "remind") return actual === "sent_as_is" ? { key: "extra_ask", label: "多提醒" } : { key: "right", label: "✓" };
  if (decision === "refuse") return { key: "other", label: "—" };
  if (decision === "auto_send" || decision === "approve") {
    return actual === "sent_as_is" ? { key: "right", label: "✓" }
      : actual === "nothing" ? { key: "wrong_send", label: "误发（本不用回）" } : { key: "wrong_send", label: "误发（你会写别的）" };
  }
  if (decision === "skip") return actual === "nothing" ? { key: "right", label: "✓" } : { key: "missed", label: "漏了" };
  return actual === "own_reply" || actual === "emoji" ? { key: "right", label: "✓" } : { key: "extra_ask", label: "多问" };
}
const CHOICE_LABELS: Record<string, string> = {
  send_draft: "照发", post_review: "发到 PR", send_edited: "改了再发", dismiss: "不回", reply_myself: "自己回",
  replied_in_source: "自己回了", undo_auto_reply: "撤回",
};

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const pct = (value: number | null | undefined) => typeof value === "number" ? `${Math.round(value * 100)}` : "—";

function score(entry: CaseEntry, input: ConfidenceModelInput, key: keyof ConfidenceModelInput["scores"]): string {
  const value = input.scores[key];
  return typeof value === "number" ? `${pct(value)}${entry.assumed?.includes(key) ? "*" : ""}` : "—";
}

function shortReason(result: ConfidenceModelResult): string {
  return result.reasons.join("；");
}

const LANE_LABELS: Record<ConfidenceModelInput["facts"]["audience"], string> = {
  dm: "私信", group_dm: "群聊", private_channel: "私有频道", public_channel: "公开频道",
};

function jevCase(entry: CaseEntry, input: ConfidenceModelInput): JevCase | null {
  if (entry.live) return readLiveCase(LIVE_DB, entry.live);
  if (!entry.jev) return null;
  return {
    message: entry.jev.message, recent: [], result: draftResult(entry.jev.draft), reads: [],
    senderTrust: isSenderTrust(input.facts.senderTrust) ? input.facts.senderTrust : "unknown",
    laneLabel: input.facts.externalShared ? "和外部组织共享的频道" : LANE_LABELS[input.facts.audience] ?? "对话",
  };
}

function costLine(result: ConfidenceModelResult): string {
  return result.cost.steps.map((step) => step.id === "audience" ? `${step.detail} L${step.levels}` : `${step.label}+${step.levels}`).join(" ");
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1]!.split(",")) : null;
  const out = args.includes("--out") ? insideRoot(args[args.indexOf("--out") + 1]!) : null;
  const lockWeight = args.includes("--lock-weight") ? Number(args[args.indexOf("--lock-weight") + 1]) : CONFIDENCE_MODEL_DEFAULTS.lockWeight;
  if (!Number.isFinite(lockWeight) || lockWeight <= 0 || lockWeight > 100) throw new Error("--lock-weight 要是 0 到 100 之间的数");
  let model: SmartModel | null = null;
  if (args.includes("--jev")) {
    const apiKey = (process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY)?.trim();
    if (!apiKey) throw new Error("--jev 要在环境变量 JEV_API_KEY 或 TYPESAFE_API_KEY 里放 Jev 的密钥");
    model = createJevSmartModel({ apiKey, model: process.env.JEV_MODEL, endpoint: process.env.JEV_ENDPOINT, timeoutMs: 15_000 });
  }
  let rescored = 0;
  const useCache = !model && !args.includes("--no-jev-cache") && existsSync(JEV_CACHE);
  const cache: Record<string, JevCacheEntry> = useCache ? JSON.parse(readFileSync(JEV_CACHE, "utf8")) as Record<string, JevCacheEntry> : {};
  const saved: Record<string, JevCacheEntry> = {};
  let cached = 0;
  const files = [path.join(DIR, "cases.json"), path.join(DIR, "my-cases.json")];
  const rows: Array<{
    entry: CaseEntry; input: ConfidenceModelInput; labeled: ConfidenceModelInput["intent"]; hard: ConfidenceModelResult; weighted: ConfidenceModelResult;
  }> = [];
  for (const file of files) {
    const data = load(path.relative(ROOT, file));
    const defaults = data.defaults ?? load(path.relative(ROOT, files[0]!)).defaults ?? {};
    for (const entry of data.cases) {
      if (entry.skip || (only && !only.has(entry.id))) continue;
      const input = toInput(entry, defaults);
      const labeled = input.intent;
      const hit = cache[entry.id];
      if (hit) {
        input.scores = { ...input.scores, ...hit.scores };
        if (hit.intent) input.intent = hit.intent;
        entry.assumed = (entry.assumed ?? []).filter((key) => !hit.answered.includes(key));
        cached++;
      }
      const asked = model ? jevCase(entry, input) : null;
      if (model && asked) {
        const answer = await rescoreWithModel(asked, model);
        input.scores = { ...input.scores, ...answer.scores };
        if (answer.intent) input.intent = answer.intent;
        entry.assumed = (entry.assumed ?? []).filter((key) => !answer.answered.includes(key));
        if (answer.answered.length) {
          rescored++;
          saved[entry.id] = { scores: answer.scores, answered: answer.answered, grounded: "v3", ...(answer.intent ? { intent: answer.intent } : {}) };
        }
        for (const error of answer.errors) console.error(`${entry.id}：${error}`);
      }
      rows.push({
        entry, input, labeled,
        hard: evaluateConfidenceModel(input, CONFIDENCE_MODEL_DEFAULTS),
        weighted: evaluateConfidenceModel(input, { ...CONFIDENCE_MODEL_DEFAULTS, lockMode: "weighted", lockWeight }),
      });
    }
  }

  const table = [
    "| 用例 | 意图 | 要回 | 做到 | 有据 | 理解 | 核实 | 信心 | 代价 | 门槛 | 结论 | 你在 Slack 里 | 对不对 | 原因 | 加权底线 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(({ entry, input, labeled, hard, weighted }) => {
      const sources = input.facts.sources;
      const verified = sources.total ? `${sources.verified}/${sources.total}${sources.verified < sources.total ? "✗" : ""}` : "—";
      const confidence = hard.confidence === null ? "—" : `${pct(hard.confidence)}%`;
      const threshold = hard.threshold === null ? "不发" : `${pct(hard.threshold)}%`;
      const weightedCell = weighted.decision === hard.decision ? "同左" : `${DECISION_LABELS[weighted.decision]}（${pct(weighted.confidence)}%）`;
      const intentText = (intent: ConfidenceModelInput["intent"]) => intent
        ? `${CONFIDENCE_INTENT_LABELS[intent.kind]}${intent.closing ? `（${CLOSING_LABELS[intent.closing]}）` : ""}` : "—";
      // 用的是请求 A 认出的意图，和人工标的不一样时标出来。
      const intent = intentText(input.intent)
        + (labeled && input.intent && (labeled.kind !== input.intent.kind || (labeled.closing ?? null) !== (input.intent.closing ?? null))
          ? `（标注：${intentText(labeled)}）` : "");
      return `| ${cell(`${entry.id} ${entry.title ?? ""}`)} | ${intent} | ${score(entry, input, "needsReply")} | ${score(entry, input, "fulfills")} | `
        + `${score(entry, input, "grounded")} | ${score(entry, input, "askConfidence")} | ${verified} | ${confidence} | `
        + `L${hard.cost.level} ${hard.cost.name} | ${threshold} | ${DECISION_LABELS[hard.decision]} | `
        + `${entry.actual ? ACTUAL_LABELS[entry.actual] : "—"} | ${entry.actual ? verdict(hard.decision, entry.actual).label : "—"} | `
        + `${cell(shortReason(hard))} | ${weightedCell} |`;
    }),
  ].join("\n");

  // 和你在 Slack 里实际做的事对一下（只算标了 actual 的用例）。
  const labeled = rows.filter(({ entry }) => entry.actual);
  const tally: Record<string, number> = { right: 0, wrong_send: 0, missed: 0, extra_ask: 0, other: 0 };
  const decided: Record<string, number> = { auto_send: 0, approve: 0, react: 0, remind: 0, refuse: 0, skip: 0, ask_user: 0, hand_over: 0 };
  for (const { entry, hard } of labeled) {
    tally[verdict(hard.decision, entry.actual!).key]!++;
    decided[hard.decision]!++;
  }
  const summary = `标了你实际做法的用例 ${labeled.length} 个：代你回 ${decided.auto_send + decided.approve}、回表情 ${decided.react}、`
    + `提醒你 ${decided.remind}、不打扰 ${decided.skip}、问你或交给你 ${decided.ask_user + decided.hand_over}。`
    + `对 ${tally.right}，误发 ${tally.wrong_send}，漏了 ${tally.missed}，多问 ${tally.extra_ask}，别的 ${tally.other}。`;

  console.log(table);
  if (model && args.includes("--save-jev")) writeFileSync(JEV_CACHE, `${JSON.stringify(saved, null, 2)}\n`);
  const note = `* 是假设值。信心是校准以后的。加权底线的指数是 ${lockWeight}。`
    + (model ? `用 Jev 重新打分的用例有 ${rescored} 个。` : "")
    + (cached ? `${cached} 个用例用的是 jev-scores.json 里 Jev 实测的分数。` : "");
  console.log(`\n${note}\n${summary}`);

  if (out) {
    const details = rows.map(({ entry, hard }) => [
      `### ${entry.id} ${entry.title ?? ""}`,
      "",
      [entry.ref && `来源：${entry.ref}`, entry.quote && `原话：${entry.quote}`, typeof entry.draft === "string" && `草稿：${entry.draft}`,
        entry.choice && `卡上：${CHOICE_LABELS[entry.choice] ?? entry.choice}`, entry.slack && `你在 Slack 里：${entry.slack}`].filter(Boolean).join("；"),
      entry.note ? `\n${entry.note}` : "",
      "",
      "```",
      `信心 ${hard.confidence === null ? "算不出" : `${pct(hard.confidence)}%`}（原始 ${pct(hard.raw)}%`
        + `${hard.calibration && Math.abs(hard.calibration.points) >= 0.5 ? `，校准 ${hard.calibration.points > 0 ? "+" : ""}${Math.round(hard.calibration.points)}` : ""}）`
        + `  ·  代价 L${hard.cost.level} ${hard.cost.name}  ·  门槛 ${hard.threshold === null ? "不自动发" : `${pct(hard.threshold)}%`}  →  ${DECISION_LABELS[hard.decision].replace(/\*/g, "")}`,
      ...hard.factors.map((factor) => `  ${factor.label.padEnd(6, "　")} ${factor.detail.padEnd(28)} ×${factor.factor.toFixed(2)}  ${factor.points >= 0 ? "+" : ""}${Math.round(factor.points)}`),
      `  代价：${costLine(hard)}`,
      `  底线：${hard.locks.map((lock) => `${lock.hit ? "✗" : "✓"} ${lock.label}（${lock.detail}）`).join("  ")}`,
      ...hard.reasons.map((reason) => `  原因：${reason}`),
      "```",
    ].join("\n")).join("\n\n");
    writeFileSync(out, `# 信心计算模型：用例结果\n\n由 \`node --import tsx packages/engine/scripts/confidence-cases.ts --out ${path.relative(ROOT, out)}\` 生成，不要手改。\n\n${table}\n\n${note}\n\n${summary}\n\n## 明细\n\n${details}\n`);
    console.log(`\n写进了 ${path.relative(ROOT, out)}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
