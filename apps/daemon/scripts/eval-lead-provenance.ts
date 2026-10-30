// 手动评测：Lead 分得清"用户发给我的消息"和系统事件吗？（2026-10-16 的事故）
//
// 不在 verify 里，也不在 CI 里：它调用真实的 Lead 模型，花 token。用法：
//   npx tsx apps/daemon/scripts/eval-lead-provenance.ts [--runs 3] [--old]
// 读数据目录（PLC_DATA_DIR，缺省 ~/.pi-lead-child）的 config.json 选 Lead 的模型和 provider，只读，不改任何东西。
// --old：用改之前的括号格式重放同一段对话，用来对比。
//
// 重放的是事故那段对话的精简版：用户在 17:56、18:00、18:19 发了三条消息，Lead 都回答了；
// 之后到第二天 08:30 来了十来条系统事件（blocker、心跳巡检、整理笔记）；然后用户问"你知道我前面发给你的3条消息吗"。
// 合格的回答要说出这三条（时间或原话）。不带工具：答案只能来自对话本身。
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { dataDir } from "@pi-lead-child/core";
import {
  leadSystemEvent, leadUserMessage, loadLeadModelConfig, registerLeadProviders, renderLeadSystemPrompt,
  resolveLeadModel, selectedLeadModelSpec,
} from "@pi-lead-child/lead";

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1] ?? 3) || 3;
const oldFormat = args.includes("--old");

const USER_TURNS = [
  { at: "2026-10-15T17:56:41+08:00", text: "再处理一下 #66 的核查" },
  { at: "2026-10-15T18:00:03+08:00", text: "你知道发生什么了吗" },
  { at: "2026-10-15T18:19:02+08:00", text: "现在能做什么？" },
];
const ANSWERS = [
  "好，我去看 #66 的独立核查为什么没派出去。",
  "知道：#66 的交付进了 review，但核查一直没派发，所以卡住了。",
  "现在可以由你直接验收 #66，或者让我再派一次核查。",
];
const SYSTEM_EVENTS = [
  { at: "2026-10-15T19:11:20+08:00", kind: "blocker" as const, text: "通知 #412（记在工单 #66）：工单 #66 reviewer Run #87 崩溃" },
  { at: "2026-10-15T19:19:35+08:00", kind: "blocker" as const, text: "通知 #413（记在工单 #66）：工单 #66 reviewer 重试已耗尽（1/1）" },
  { at: "2026-10-15T19:40:00+08:00", kind: "heartbeat" as const, text: "心跳巡检：以上是积压的系统通知。请消化处理。" },
  { at: "2026-10-15T20:06:47+08:00", kind: "blocker" as const, text: "通知 #414（记在工单 #71）：工单 #71 执行重试已耗尽（执行失败 2/2）" },
  { at: "2026-10-15T21:10:00+08:00", kind: "heartbeat" as const, text: "心跳巡检：以上是积压的系统通知。请消化处理。" },
  { at: "2026-10-15T22:40:00+08:00", kind: "precipitate" as const, text: "系统：你的上下文水位已接近自动压缩阈值，现在执行沉淀检查。" },
  { at: "2026-10-16T00:10:00+08:00", kind: "heartbeat" as const, text: "心跳巡检：以上是积压的系统通知。请消化处理。" },
  { at: "2026-10-16T02:40:00+08:00", kind: "heartbeat" as const, text: "心跳巡检：以上是积压的系统通知。请消化处理。" },
  { at: "2026-10-16T05:10:00+08:00", kind: "heartbeat" as const, text: "心跳巡检：以上是积压的系统通知。请消化处理。" },
  { at: "2026-10-16T07:40:00+08:00", kind: "heartbeat" as const, text: "心跳巡检：以上是积压的系统通知。请消化处理。" },
];
const QUESTION = { at: "2026-10-16T08:30:07+08:00", text: "你知道我前面发给你的3条消息吗" };

function clock(at: string): string {
  return oldFormat ? `（当前时间：${at}，时区 Asia/Shanghai）` : leadSystemEvent("clock", `当前时间：${at}，时区 Asia/Shanghai`);
}

function userTurn(at: string, text: string): string {
  return oldFormat
    ? `${clock(at)}\n\n（来源：localhost-web，channel=paired:companion）\n${text}`
    : `${clock(at)}\n\n${leadUserMessage({ via: "localhost-web", channel: "paired:companion" }, text)}`;
}

function systemTurn(at: string, kind: "blocker" | "heartbeat" | "precipitate", text: string): string {
  return oldFormat ? `${clock(at)}\n\n（系统通知：${text}）` : `${clock(at)}\n\n${leadSystemEvent(kind, text)}`;
}

async function main(): Promise<void> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  const config = loadLeadModelConfig(dataDir());
  await registerLeadProviders(runtime, config);
  const spec = selectedLeadModelSpec(config);
  const { model } = await resolveLeadModel(runtime, spec);

  const assistant = (text: string) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  });
  const user = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });

  const messages = [
    ...USER_TURNS.flatMap((turn, index) => [user(userTurn(turn.at, turn.text)), assistant(ANSWERS[index]!)]),
    ...SYSTEM_EVENTS.flatMap((event) => [user(systemTurn(event.at, event.kind, event.text)), assistant("NO_REPLY")]),
    user(userTurn(QUESTION.at, QUESTION.text)),
  ];

  console.log(`model ${spec} · ${oldFormat ? "old format" : "new format"} · ${runs} run(s)`);
  let passed = 0;
  for (let run = 1; run <= runs; run += 1) {
    const reply = await runtime.completeSimple(model, { systemPrompt: renderLeadSystemPrompt(), messages: messages as never });
    const text = reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    // 每一条都要被认出来：原话里的关键词或者发送时间。
    const found = USER_TURNS.map((turn) => {
      const minute = turn.at.slice(11, 16);
      const keyword = turn.text.replace(/[？?。]/gu, "").slice(0, 6);
      return text.includes(minute) || text.includes(keyword);
    });
    const ok = found.every(Boolean);
    if (ok) passed += 1;
    console.log(`\n── run ${run}: ${ok ? "PASS" : "FAIL"} (${found.map((hit) => (hit ? "✓" : "✗")).join(" ")})\n${text}`);
  }
  console.log(`\n${passed}/${runs} passed`);
  process.exitCode = passed === runs ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
