// 当前局面和输入放置在真实的 pi 会话上是不是这样工作（工单 04，spec D6、D7）。daemon 的做法依赖 pi 的几条行为，
// 这里用 pi 自己的会话（createAgentSession）加 pi-ai 的假模型（faux）钉住它们：
//   · 当前局面放在每一轮输入的开头（<system_event kind="situation">），系统提示不因为它变化：两轮之间发给模型的
//     系统消息一样，提示缓存不失效（Lead 用的模型接口大多不接受对话中途的系统消息，系统提示一变整段缓存就没了）；
//   · 用户排队的消息（followUp，followUpMode=all）在 Lead 答完以后一起送进下一次调模型；
//   · 插话在最后的回答写到一半时到达，pi 在这个回答结束以后送进下一次调模型（daemon 据此标「下一轮回答」）；
//   · 每条送进上下文的用户消息都发 message_start（role=user，内容是交出去的原文），daemon 据此改接出水口。
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { tempDir } from "@pi-lead-child/core/testing";
import { leadSystemEvent, leadUserMessage } from "../src/envelope.js";
import { renderLeadSystemPrompt } from "../src/prompt.js";
import { renderLeadSituation } from "../src/situation.js";

const sessions: AgentSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

type Step = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];
type Message = { role: string; content: unknown; sections?: Record<string, string | null> };
// 一次调模型看到的：系统消息（按顺序渲染成文字）和用户消息。
type Seen = { system: string[]; users: string[] };

const textOf = (content: unknown) => typeof content === "string" ? content
  : (content as Array<{ type: string; text?: string }>).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");

function seenBy(context: { messages: Message[] }): Seen {
  return {
    system: context.messages.filter((message) => message.role === "system")
      .map((message) => getSystemMessageText(message as never)),
    users: context.messages.filter((message) => message.role === "user").map((message) => textOf(message.content)),
  };
}

// 和 createLeadSession 一样的系统提示：Lead 的提示词经 systemPromptOverride 给出，会话里不另加别的。
async function leadLikeSession(responses: Step[]) {
  const cwd = tempDir("plc-lead-situation-");
  const agentDir = join(cwd, "agent");
  const faux = fauxProvider({ provider: "plc-lead-situation-test", api: "plc-lead-situation-test-api" });
  faux.setResponses(responses);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const systemPrompt = renderLeadSystemPrompt();
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    extensionFactories: [{ name: "provider", factory: (pi) => pi.registerProvider(faux.provider) }],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd, agentDir, model: faux.getModel(), thinkingLevel: "off", resourceLoader: loader, sessionManager, settingsManager,
  });
  sessions.push(session);
  await session.bindExtensions({});
  session.setFollowUpMode("all");
  const delivered: string[] = [];
  const order: string[] = [];
  session.subscribe((event: any) => {
    if (event.type === "message_start" && event.message?.role === "user") {
      delivered.push(textOf(event.message.content));
      order.push(`user:${textOf(event.message.content)}`);
    }
    if (event.type === "message_end" && event.message?.role === "assistant") order.push(`assistant:${textOf(event.message.content)}`);
  });
  return { session, delivered, order };
}

function situationEnvelope(ticketLine: string): string {
  return leadSystemEvent("situation", renderLeadSituation({
    now: "2026-10-17T10:00:00+08:00", tickets: [{ line: ticketLine }], problems: [], waiting: [], queued: [],
    digest: [], records: [], unread: 0, leadFailure: null,
  }).text);
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

describe("the situation at the start of each round's input", () => {
  it("leaves the system prompt sent to the model unchanged from one round to the next", async () => {
    const seen: Seen[] = [];
    const { session } = await leadLikeSession([
      (context) => { seen.push(seenBy(context as never)); return fauxAssistantMessage("第一次回答"); },
      (context) => { seen.push(seenBy(context as never)); return fauxAssistantMessage("第二次回答"); },
    ]);
    const user = (text: string) => leadUserMessage({ via: "app", channel: "paired:companion" }, text);

    await session.prompt(`${situationEnvelope("#77「部署」：active")}\n\n${user("第一句")}`, { expandPromptTemplates: false });
    await session.prompt(`${situationEnvelope("#77「部署」：done")}\n\n${user("第二句")}`, { expandPromptTemplates: false });

    expect(seen).toHaveLength(2);
    // 当前局面变了，系统提示没有变：没有新加的系统消息，原来的也一样（提示缓存可以接着用）。
    expect(seen[1]!.system).toEqual(seen[0]!.system);
    expect(seen[0]!.system.join("\n")).not.toContain("#77「部署」");
    // 当前局面在这一轮的输入里，和用户的话分开：第二轮的输入是新的一份，前一份留在前面的历史里，不改。
    expect(seen[1]!.users.at(-1)).toContain('<system_event kind="situation" source="daemon">');
    expect(seen[1]!.users.at(-1)).toContain("#77「部署」：done");
    expect(seen[1]!.users.at(-1)).toContain('<user_message from="user"');
    expect(seen[1]!.users[0]).toBe(seen[0]!.users[0]);
  });
});

describe("input placement on a real pi session", () => {
  it("delivers every queued follow-up together after the answer, and reports each delivery", async () => {
    const first = gate();
    const reached = gate();
    const seen: Seen[] = [];
    const { session, delivered } = await leadLikeSession([
      async (context) => {
        seen.push(seenBy(context as never));
        reached.open();
        await first.opened;
        return fauxAssistantMessage("A 的回答");
      },
      (context) => { seen.push(seenBy(context as never)); return fauxAssistantMessage("两条排队的一起答"); },
    ]);
    const running = session.prompt("问题 A", { expandPromptTemplates: false });
    await reached.opened;
    await session.followUp("排队 1");
    await session.followUp("排队 2");
    first.open();
    await running;

    expect(seen).toHaveLength(2);
    expect(seen[1]!.users.slice(-2)).toEqual(["排队 1", "排队 2"]);
    expect(seen[1]!.system).toEqual(seen[0]!.system);
    expect(delivered).toEqual(["问题 A", "排队 1", "排队 2"]);
  });

  it("delivers a steer that arrives during the final answer only after that answer", async () => {
    const first = gate();
    const reached = gate();
    const { session, order } = await leadLikeSession([
      async () => { reached.open(); await first.opened; return fauxAssistantMessage("A 的回答"); },
      () => fauxAssistantMessage("B 的回答"),
    ]);
    const running = session.prompt("问题 A", { expandPromptTemplates: false });
    await reached.opened;
    await session.steer("插话 B");
    first.open();
    await running;
    expect(order).toEqual(["user:问题 A", "assistant:A 的回答", "user:插话 B", "assistant:B 的回答"]);
  });
});
