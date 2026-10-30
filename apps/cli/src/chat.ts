// plc chat：和 companion 一样走网关。消息用 chat.send 发出，回答从网关事件里渲染。
// 每一轮都记在账本的会话流里（带着 plc 的 binding），所以 companion 里也看得到 CLI 的对话。
// 打的每一行先写进发件箱文件（chat-outbox-file.ts），再发出去：断线、发送失败、重启都丢不了。
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ChatOutbox, type ControlPlaneClient, type OutboxEntry, type OutboxStorage } from "@pi-lead-child/client";
import {
  DEFAULT_LEAD_NAME, isDaemonNoticeOrigin, leadTurnFailureSentence, leadTurnWaitingSentence, PRESENCE_IDLE_MS, systemTurnLabel, type GatewayEvent, type HelloV2,
} from "@pi-lead-child/protocol";
import { fileOutboxStorage } from "./chat-outbox-file.js";

const DIM = (text: string) => `\x1b[2m${text}\x1b[0m`;
// 旧版 daemon 把 401 改写成的那句。它不是技术详情，不再印一遍。
const OLD_DAEMON_AUTH_ERROR = "Lead 模型连接认证失败，请重试。";
const YELLOW = (text: string) => `\x1b[33m${text}\x1b[0m`;
const CYAN = (text: string) => `\x1b[36m${text}\x1b[0m`;

function preview(value: unknown): string {
  const text = JSON.stringify(value ?? {});
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

// 提示里引用一条消息：一行，最多 40 个字。
function quote(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return `「${line.length > 40 ? `${line.slice(0, 40)}…` : line}」`;
}

export interface ChatOutput {
  write(text: string): void;
  prompt(): void;
}

// 把网关事件变成终端输出。渲染三类：发给这个 binding 的轮次（audienceBindingId 是自己），
// 发给所有人的系统轮次（lead 自己发起的回合和 daemon 的系统通知，audienceBindingId 为 null），
// 以及审批请求。别的客户端发起的轮次不渲染：这里没有那句提问。
export class ChatRenderer {
  private state: "connecting" | "connected" | "reconnecting" | "disconnected" = "connecting";
  private reconnectNoticeShown = false;
  // Lead 的名字（设置 → 身份与风格）。连上以后读一次 /v1/lead/profile，读不到时用缺省的。
  leadName: string = DEFAULT_LEAD_NAME;

  constructor(private readonly bindingId: number, private readonly out: ChatOutput) {}

  // 连接状态。daemon 重启时只说一次"正在重连"，不在每次退避重试时打印错误。
  connection(state: "connecting" | "connected" | "reconnecting" | "disconnected"): void {
    this.state = state;
    if (state === "connected") this.reconnectNoticeShown = false;
    if (state === "reconnecting" && !this.reconnectNoticeShown) {
      this.reconnectNoticeShown = true;
      this.out.write(`\n${DIM("（daemon 重启中，正在重连）")}\n`);
    }
  }

  // 连接中、重连中的错误（daemon 还没起来、端口还没开）都是重连的一部分，不打印。
  protocolError(error: Error): void {
    if (this.state !== "connected") return;
    this.out.write(`\n${DIM(`[gateway] ${error.message}`)}\n`);
  }

  hello(hello: HelloV2, gatewayUrl: string): void {
    const busy = hello.daemon.busy ? "，正在处理其他请求" : "";
    this.out.write(`${this.leadName} ready (model=${hello.daemon.model}, session=${hello.daemon.sessionId}${busy})\n`);
    this.out.write(`网关: ${gatewayUrl}；/quit 断开（daemon 继续常驻），plc daemon stop 才是停机\n\n`);
    this.out.prompt();
  }

  // 审批（approval.required）不会到这里：plc 的凭证做不了用户的决定，网关不给它发（store 的 bindingScopes）。
  event(event: GatewayEvent): void {
    if (event.audienceBindingId !== this.bindingId && event.audienceBindingId !== null) return;
    switch (event.type) {
      case "lead.turn.started": {
        const origin = typeof event.payload.originKind === "string" ? event.payload.originKind : null;
        // Lead 自己发起的回合写 Lead 的名字；daemon 的系统通知照旧写「系统通知 …」。
        const label = isDaemonNoticeOrigin(origin) ? systemTurnLabel(origin) : systemTurnLabel(origin) ? this.leadName : null;
        if (label) this.out.write(`\n${CYAN(`[${label}]`)}\n`);
        else if (event.payload.mode === "steered") this.out.write(`${DIM(`（已插话，${this.leadName} 将在当前步骤后看到）`)}\n`);
        return;
      }
      case "lead.message.delta":
        this.out.write(String(event.payload.delta ?? ""));
        return;
      case "lead.tool.started": {
        // render_ui 画的卡片：命令行画不了，打印 Lead 写的 fallback_text（generative UI spec D8）。
        const fallback = event.payload.toolName === "render_ui"
          ? (event.payload.args as { fallback_text?: unknown } | undefined)?.fallback_text
          : undefined;
        if (typeof fallback === "string" && fallback.trim()) {
          this.out.write(`\n${CYAN(`[卡片] ${fallback.trim()}`)}\n`);
          return;
        }
        this.out.write(`\n${DIM(`· ${String(event.payload.toolName ?? "tool")}(${preview(event.payload.args)})`)}\n`);
        return;
      }
      case "lead.message.completed":
        this.out.write("\n");
        this.out.prompt();
        return;
      case "notice.created": {
        // 在等那一次自动重试：不是失败（daemon 的 waitToRetry）。
        if (event.payload.retry === "waiting") {
          const waitingFor = event.payload.waitingFor === "network" ? "network" : "model";
          this.out.write(`\n${DIM(`（${leadTurnWaitingSentence(String(event.payload.message ?? ""), waitingFor, this.leadName)}）`)}\n`);
          return;
        }
        // 和 companion 的失败卡片用同一套分类说成一句话：认证失败不叫人重试；原文放在下面一行。
        // 发给所有人的（audienceBindingId 为 null）是 Lead 自己发起的一轮，没有人在等回答。
        const raw = String(event.payload.message ?? "");
        const sentence = leadTurnFailureSentence(raw, { system: event.audienceBindingId === null, name: this.leadName });
        this.out.write(`\n${YELLOW(`[error] ${sentence ?? raw}`)}\n`);
        if (sentence && raw.trim() !== OLD_DAEMON_AUTH_ERROR) this.out.write(`${DIM(`技术详情：${raw.length > 300 ? `${raw.slice(0, 300)}…` : raw}`)}\n`);
        this.out.prompt();
        return;
      }
      default:
    }
  }
}

const WAITING = "（待发送：连接恢复后发送）";
const failedText = (reason: string | null) => `（发送失败：${reason ?? "未知原因"}；输入 /retry 重试，/drop 删除）`;

// 输入行的去向。每一行先写进发件箱，再由发件箱发出：一次一条，按顺序，只在网关打过招呼以后发。
// 事件流只收连上之后的新事件，事件流断着时发出的那一轮的回答会收不到。
// 发件箱的状态印在终端里：待发送、发送失败。/retry 重发、/drop 删除最近一条发送失败的消息。
export class ChatInput {
  private readonly outbox: ChatOutbox;
  private connected = false;
  // 读回发件箱时不逐条打印，restore() 一次说完。
  private quiet = false;
  // 停下以后什么都不打印：输入已经关了。
  private stopped = false;
  // 已经说过待发送、发送失败的消息（clientMessageId）：每种状态只说一次。
  private readonly waitingShown = new Set<string>();
  private readonly failedShown = new Set<string>();

  constructor(
    client: Pick<ControlPlaneClient, "sendChatCommand">,
    storage: OutboxStorage,
    private readonly out: ChatOutput,
  ) {
    this.outbox = new ChatOutbox({
      storage,
      // 命令 id 就用 clientMessageId：重发时不变，daemon 按它去重。
      send: (entry) => client.sendChatCommand({
        id: entry.clientMessageId,
        message: entry.message,
        clientMessageId: entry.clientMessageId,
      }),
      isConnected: () => this.connected,
      onChange: (entries) => this.changed(entries),
    });
  }

  // 读回上次没送达的消息，说一共几条。待发送的连上以后发出，发送失败的等 /retry 或 /drop。
  async restore(): Promise<void> {
    this.quiet = true;
    try {
      await this.outbox.load();
    } finally {
      this.quiet = false;
    }
    const entries = this.outbox.entries();
    if (!entries.length) return;
    for (const entry of entries) (entry.state === "failed" ? this.failedShown : this.waitingShown).add(entry.clientMessageId);
    const failed = entries.filter((entry) => entry.state === "failed").length;
    const summary = failed
      ? `（恢复了 ${entries.length} 条未发送的消息：${entries.length - failed} 条连接后发送，${failed} 条发送失败；输入 /retry 重试，/drop 删除）`
      : `（恢复了 ${entries.length} 条未发送的消息，连接后发送）`;
    this.out.write(`${DIM(summary)}\n`);
    for (const entry of entries) {
      this.out.write(`${DIM(`  · ${quote(entry.message)}${entry.state === "failed" ? `（发送失败：${entry.error ?? "未知原因"}）` : ""}`)}\n`);
    }
  }

  line(raw: string): "quit" | "empty" | "command" | "queued" | "sent" {
    const message = raw.trim();
    if (message === "/quit" || message === "/exit") return "quit";
    if (!message) return "empty";
    if (message === "/retry") { this.retry(); return "command"; }
    if (message === "/drop") { void this.drop(); return "command"; }
    const queued = !this.connected;
    void this.outbox.enqueue(message).then((entry) => {
      // 写进发件箱以后还没连上：说一声，接着打字。连着时不说，回答完了再给提示符。
      if (this.stopped || this.connected || this.waitingShown.has(entry.clientMessageId)) return;
      this.waitingShown.add(entry.clientMessageId);
      this.out.write(`${DIM(WAITING)}\n`);
      this.out.prompt();
    });
    return queued ? "queued" : "sent";
  }

  // 网关打过招呼：不等退避，马上发。
  ready(): void {
    this.connected = true;
    this.outbox.connected();
  }

  offline(): void {
    this.connected = false;
  }

  // 断开时还没有结果的那条以 disconnected 失败，回到待发送，存进文件，下次启动重发。
  stop(): void {
    this.stopped = true;
    this.outbox.stop();
  }

  private latestFailed(): OutboxEntry | undefined {
    return this.outbox.entries().filter((entry) => entry.state === "failed").at(-1);
  }

  private retry(): void {
    const entry = this.latestFailed();
    if (!entry) {
      this.out.write(`${DIM("（没有发送失败的消息）")}\n`);
      this.out.prompt();
      return;
    }
    this.out.write(`${DIM(`（重试：${quote(entry.message)}）`)}\n`);
    this.outbox.retry(entry.clientMessageId);
    if (this.connected) return;
    this.waitingShown.add(entry.clientMessageId);
    this.out.write(`${DIM(WAITING)}\n`);
    this.out.prompt();
  }

  private async drop(): Promise<void> {
    const entry = this.latestFailed();
    if (entry) await this.outbox.remove(entry.clientMessageId);
    if (this.stopped) return;
    this.out.write(`${DIM(entry ? `（已删除：${quote(entry.message)}）` : "（没有发送失败的消息）")}\n`);
    this.out.prompt();
  }

  // 发件箱有变化：新的发送失败说一次；临时错误（断线、超时）以后回到待发送的也说一次。
  private changed(entries: readonly OutboxEntry[]): void {
    if (this.quiet || this.stopped) return;
    const current = new Set(entries.map((entry) => entry.clientMessageId));
    for (const shown of [this.waitingShown, this.failedShown]) {
      for (const id of shown) if (!current.has(id)) shown.delete(id);
    }
    for (const entry of entries) {
      const id = entry.clientMessageId;
      if (entry.state !== "failed") this.failedShown.delete(id);
      if (entry.state === "failed" && !this.failedShown.has(id)) {
        this.failedShown.add(id);
        this.out.write(`\n${YELLOW(failedText(entry.error))}\n`);
        this.out.prompt();
      } else if (entry.state === "pending" && entry.error !== null && !this.waitingShown.has(id)) {
        this.waitingShown.add(id);
        this.out.write(`\n${DIM(WAITING)}\n`);
        this.out.prompt();
      }
    }
  }
}

// plc chat 的"有人在看"：运行中算，PRESENCE_IDLE_MS（5 分钟）没有输入就不算，下一次输入又算。
export class IdlePresence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attended = false;

  constructor(private readonly send: (attended: boolean) => void, private readonly idleMs: number = PRESENCE_IDLE_MS) {}

  start(): void {
    this.input();
  }

  input(): void {
    if (!this.attended) {
      this.attended = true;
      this.send(true);
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.attended = false;
      this.send(false);
    }, this.idleMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

// 凭证被拒（撤销、账本重置）时 runChat 以那个错误结束：plc 打印重新签发的提示，退出码 1。
export async function runChat(
  client: ControlPlaneClient,
  args: {
    bindingId: number;
    // 网关地址每次连上时都重新问 daemon（重启后端口可能变了），横幅里显示的是当前地址。
    gatewayUrl: () => Promise<string>;
    // 发件箱文件（chatOutboxPath()）。测试给临时目录里的文件。
    outboxPath: string;
    io?: { input: Readable; output: Writable };
  },
): Promise<void> {
  const stdin = args.io?.input ?? process.stdin;
  const stdout = args.io?.output ?? process.stdout;
  const output: ChatOutput = {
    write: (text) => stdout.write(text),
    prompt: () => rl.prompt(),
  };
  const input = new ChatInput(client, fileOutboxStorage(args.outboxPath), output);
  // 先读完发件箱，再接上输入：这期间打的字留在输入流里，不会丢。
  await input.restore();
  const rl = createInterface({ input: stdin, output: stdout, prompt: "you> " });
  const renderer = new ChatRenderer(args.bindingId, output);
  let rejected: Error | null = null;
  // 每断一次加一。问网关地址是异步的：问到之前连接又断了，这次打招呼就不算连上。
  let connection = 0;
  // plc chat 开着、最近 5 分钟有输入，就算有人在看：daemon 这时让 lead 播报即时通知，桌面通知不弹。
  const presence = new IdlePresence((attended) => client.setPresence(attended));
  presence.start();
  // 先接上输入，再连网关：连接期间打的字不能丢。
  const closed = new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      presence.input();
      const outcome = input.line(line);
      if (outcome === "quit") rl.close();
      else if (outcome === "empty") rl.prompt();
    });
    rl.on("close", () => {
      presence.stop();
      input.stop();
      client.disconnect();
      // readline 关闭后 stdin 还开着，进程不会自己退出。
      stdin.destroy();
      if (!rejected) stdout.write("已断开（daemon 与 child 仍在后台常驻）\n");
      resolve();
    });
  });
  await client.connect({
    onHello: (hello) => {
      const greeted = connection;
      const leadName = typeof client.getLeadProfile === "function"
        ? client.getLeadProfile().then((profile) => profile.name, () => renderer.leadName)
        : Promise.resolve(renderer.leadName);
      void Promise.all([args.gatewayUrl().catch(() => "（地址未知）"), leadName]).then(([url, name]) => {
        if (greeted !== connection) return;
        renderer.leadName = name;
        renderer.hello(hello, url);
        input.ready();
      });
    },
    onEvent: (event) => renderer.event(event),
    onStateChange: (state) => {
      if (state !== "connected") {
        connection += 1;
        input.offline();
      }
      renderer.connection(state);
    },
    onProtocolError: (error) => renderer.protocolError(error),
    onCredentialRejected: (error) => {
      rejected = error;
      rl.close();
    },
  });
  await closed;
  if (rejected) throw rejected;
}
