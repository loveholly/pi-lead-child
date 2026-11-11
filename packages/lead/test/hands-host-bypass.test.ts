// 免沙箱的 bash（docs/ticket-246-user-turn-bypass.md 3.1、3.2，实施单 C）：真实的 pi 会话，hands 扩展和凭证防护照 Lead 加载，
// 模型是 pi-ai 的假模型，按脚本调用 bash。断言命令在哪里跑：沙箱外不调 sandbox-runtime 的 wrapWithSandboxArgv。
// 这里只测分流：sandbox-runtime 换成假的（包装成直接跑），在本身就在沙箱里的环境（嵌套的 sandbox-exec 起不来）也能跑。
// 真的沙箱和开关关着时的行为由 hands.test.ts 覆盖（那个文件不改一行）。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { tempDir } from "@pi-lead-child/core/testing";
import { HOST_COMMAND_STARTED_KIND } from "@pi-lead-child/protocol";
import {
  addLeadFollowUp, channelOwnerBinding, completeTurn, createLoopbackBinding, createTurn, listEvents, openDb, type Db,
} from "@pi-lead-child/store";
import { enableHostBypass, resetSandboxForTests } from "@pi-lead-child/engine";
import { credentialGuardExtension } from "../src/credential-guard.js";
import { HOST_RUN_MARK, leadHandsExtension } from "../src/hands.js";
import { withExternalContent, type LeadTurnOrigin } from "../src/turn-origin.js";

type Step = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];
const bash = (command: string, extra: Record<string, unknown> = {}): Step =>
  fauxAssistantMessage([fauxToolCall("bash", { command, ...extra } as never)], { stopReason: "toolUse" });

let dir: string;
let db: Db;
let turnId: string | null;
let origin: LeadTurnOrigin;

let wrap: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await resetSandboxForTests();
  vi.spyOn(SandboxManager, "isSupportedPlatform").mockReturnValue(true);
  vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined as never);
  vi.spyOn(SandboxManager, "reset").mockResolvedValue(undefined as never);
  wrap = vi.spyOn(SandboxManager, "wrapWithSandboxArgv")
    .mockImplementation((async (command: string) => ({ argv: ["/bin/sh", "-c", command] })) as never);
  dir = tempDir("plc-hands-bypass-");
  db = openDb(join(dir, "plc.db"));
  turnId = null;
  origin = { external: false, timer: null };
});

afterEach(async () => {
  await resetSandboxForTests();
  vi.restoreAllMocks();
  db.close();
});

function turnOn(): void {
  enableHostBypass(db, { bindingId: null, resolvedBy: "user via Mac 网页", reason: "test", now: new Date() });
}

function companionTurn(id: string): void {
  const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
  createTurn(db, { id, originBindingId: binding.id, originKind: "paired:companion", userText: "…", state: "streaming" });
  turnId = id;
}

// afterEnd：第 n 个 bash 结束以后调用（模拟 daemon 在同一轮里记下外部内容）。
async function session(steps: Step[], afterEnd: (index: number) => void = () => {}): Promise<Array<{ isError: boolean; text: string }>> {
  const faux = fauxProvider({ provider: "plc-hands-bypass", api: "plc-hands-bypass-api" });
  faux.setResponses([...steps, fauxAssistantMessage("好了。")]);
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "test",
    extensionFactories: [
      { name: "provider", factory: (pi) => pi.registerProvider(faux.provider) },
      { name: "plc-credential-guard", factory: credentialGuardExtension({ cwd: dir, secretValues: () => [] }) },
      {
        name: "plc-hands",
        factory: leadHandsExtension({ db, dataDir: dir, home: dir, turnOrigin: () => origin, currentTurnId: () => turnId }),
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir, agentDir, model: faux.getModel() as never, thinkingLevel: "off",
    resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), settingsManager, tools: ["bash"],
  });
  await session.bindExtensions({});
  session.setActiveToolsByName(["bash"]);
  const ends: Array<{ isError: boolean; text: string }> = [];
  session.subscribe((event: any) => {
    if (event.type !== "tool_execution_end" || event.toolName !== "bash") return;
    ends.push({ isError: event.isError === true, text: (event.result?.content ?? []).map((part: { text?: string }) => part.text ?? "").join("") });
    afterEnd(ends.length);
  });
  await session.prompt("go", { expandPromptTemplates: false });
  session.dispose();
  return ends;
}

const started = () => listEvents(db, { kind: HOST_COMMAND_STARTED_KIND }).map((event) => event.payload as Record<string, unknown>);

describe("bash with the sandbox bypass on", () => {
  it("runs outside the sandbox in the user's own turn, then back in the sandbox once the turn reads external content", async () => {
    turnOn();
    companionTurn("turn-live");
    const ends = await session([bash("echo first-host"), bash("echo second-sandbox")], (index) => {
      // 第一条跑完以后，这一轮用 read_channel_conversation 读了 Slack。
      if (index === 1) origin = withExternalContent(origin, { via: "tool", tool: "read_channel_conversation" });
    });
    expect(ends[0]?.isError).toBe(false);
    expect(ends[0]?.text.startsWith(HOST_RUN_MARK)).toBe(true);
    expect(ends[0]?.text).toContain("first-host");
    expect(ends[1]?.text).toMatch(/^（沙箱里：免沙箱开着，但这一次没有用——这一轮用 read_channel_conversation 读了外部内容/);
    expect(ends[1]?.text).toContain("second-sandbox");
    // 只有第二条经过 sandbox-exec。
    expect(wrap).toHaveBeenCalledTimes(1);
    expect(wrap.mock.calls[0]?.[0]).toBe("echo second-sandbox");
    expect(started()).toEqual([expect.objectContaining({
      turnId: "turn-live", turnOrigin: "live_user_companion", via: "bash", command: "echo first-host", spendsMoney: false,
    })]);
  }, 90_000);

  it("treats the user's Slack DM to themselves like Companion", async () => {
    turnOn();
    const slack = channelOwnerBinding(db, { subject: "slack:U000TEST", name: "Slack 私信" })!;
    createTurn(db, { id: "turn-dm", originBindingId: slack.id, originKind: "paired:companion", userText: "…", state: "streaming" });
    turnId = "turn-dm";
    const ends = await session([bash("echo from-dm")]);
    expect(ends[0]?.text.startsWith(HOST_RUN_MARK)).toBe(true);
    expect(wrap).not.toHaveBeenCalled();
    expect(started()[0]).toMatchObject({ turnOrigin: "live_user_slack_self_dm", via: "bash" });
  }, 90_000);

  it("falls back to the sandbox and says why when the screen says unknown or the command spends money", async () => {
    turnOn();
    companionTurn("turn-screen");
    const ends = await session([bash("ls \"$(echo nested)\""), bash("echo pay", { spends_money: true })]);
    for (const end of ends) expect(end.text).toMatch(/^（沙箱里：免沙箱开着，但这一次没有用——命令筛查没有放行/);
    expect(ends[0]?.text).toContain("unknown");
    expect(ends[1]?.text).toContain("floor");
    expect(wrap).toHaveBeenCalledTimes(2);
    expect(started()).toEqual([]);
  }, 90_000);

  // 回归（2026-11-11）：用户让 Fairy 设的跟进到点的一轮里，bash 一律退回沙箱，推 PR 没有 git 凭据。
  it("runs outside the sandbox in the turn of a follow-up the user set", async () => {
    turnOn();
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    createTurn(db, { id: "turn-set", originBindingId: binding.id, originKind: "paired:companion", userText: "…", state: "streaming" });
    const followUp = addLeadFollowUp(db, {
      at: new Date(Date.now() - 1_000), note: "推 PR",
      setBy: { turnId: "turn-set", bindingId: binding.id, startedAt: new Date().toISOString() },
    });
    completeTurn(db, "turn-set");
    origin = { external: false, timer: followUp };
    const ends = await session([bash("echo from-follow-up")]);
    expect(ends[0]?.text.startsWith(HOST_RUN_MARK)).toBe(true);
    expect(wrap).not.toHaveBeenCalled();
    expect(started()[0]).toMatchObject({ turnId: `timer:${followUp}`, turnOrigin: "live_user_companion", via: "bash" });
  }, 90_000);

  // 回归（2026-11-11）：超过 400 个字或者带 $(…) 的 git 命令退回沙箱。
  it("runs a long command with $(…) outside the sandbox in the user's own turn", async () => {
    turnOn();
    companionTurn("turn-long");
    const command = `echo "$(echo long-${"x".repeat(450)})"`;
    expect(command.length).toBeGreaterThan(400);
    const ends = await session([bash(command)]);
    expect(ends[0]?.text.startsWith(HOST_RUN_MARK)).toBe(true);
    expect(ends[0]?.text).toContain("long-xxx");
    expect(wrap).not.toHaveBeenCalled();
  }, 90_000);

  // 回归（2026-11-11 返工）：执行结束的通知叫醒的一轮里，bash 一律退回沙箱。现在免沙箱，读了连接结果以后才退回。
  it("runs outside the sandbox in a turn that run.finished woke, then back in the sandbox after a connection result", async () => {
    turnOn();
    origin = { external: false, timer: null, wokenBy: { origin: "system:blocker", kinds: ["run.finished"] } };
    const ends = await session([bash("echo first-host"), bash("echo second-sandbox")], (index) => {
      if (index === 1) origin = withExternalContent(origin, { via: "tool", tool: "call_connection_tool" });
    });
    expect(ends[0]?.text.startsWith(HOST_RUN_MARK)).toBe(true);
    expect(ends[1]?.text).toMatch(/^（沙箱里：免沙箱开着，但这一次没有用——这一轮用 call_connection_tool 读了外部内容/);
    expect(wrap).toHaveBeenCalledTimes(1);
    expect(wrap.mock.calls[0]?.[0]).toBe("echo second-sandbox");
    expect(started()).toEqual([expect.objectContaining({
      turnId: null, turnOrigin: "system_event", wokenBy: { origin: "system:blocker", kinds: ["run.finished"] }, via: "bash", command: "echo first-host",
    })]);
  }, 90_000);

  it("keeps a turn that an external message woke in the sandbox", async () => {
    turnOn();
    origin = {
      external: true, timer: null, externalBy: [{ via: "message", source: "slack" }], externalEvents: [7],
      wokenBy: { origin: "system:blocker", kinds: ["message.received"] },
    };
    const ends = await session([bash("echo from-slack")]);
    // 外部消息叫醒的一轮里 Fairy 自己不跑命令（handsBlockedInTurn），沙箱里也不跑，沙箱外更不跑。
    expect(ends[0]?.isError).toBe(true);
    expect(ends[0]?.text).toMatch(/^这一轮是外部消息/);
    expect(wrap).not.toHaveBeenCalled();
    expect(started()).toEqual([]);
  }, 90_000);

  it("keeps a turn of unknown origin in the sandbox", async () => {
    turnOn();
    const ends = await session([bash("echo system-turn")]);
    expect(ends[0]?.text).toMatch(/^（沙箱里：免沙箱开着，但这一次没有用——这一轮的来源认不出来/);
    expect(ends[0]?.text).toContain("system-turn");
    expect(wrap).toHaveBeenCalledTimes(1);
    expect(started()).toEqual([]);
  }, 90_000);

  it("adds nothing to the result and stays in the sandbox when the switch is off", async () => {
    companionTurn("turn-off");
    const ends = await session([bash("echo switch-off")]);
    expect(ends[0]?.text.trim()).toBe("switch-off");
    expect(wrap).toHaveBeenCalledTimes(1);
    expect(started()).toEqual([]);
  }, 90_000);
});
