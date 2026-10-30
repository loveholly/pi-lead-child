import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { attachJsonlReader } from "./jsonl.js";

// RPC 用到的进程成员。node 的 ChildProcess 和启动垫片托管的进程（工单 14）都满足它。
export interface RpcProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  on(event: "exit" | "error", listener: (...args: any[]) => void): unknown;
}

export interface RpcResponse {
  type: "response"; command: string; id?: string; success: boolean;
  data?: any; error?: string;
}

export class RpcClient extends EventEmitter {
  private pending = new Map<string, { resolve: (resp: RpcResponse) => void; reject: (err: Error) => void }>();
  private nextId = 1;
  private exited = false;
  private readonly idPrefix: string;

  // idPrefix：请求 id 的前缀。接管的进程（工单 15）用新的前缀，
  // 这样重放的旧回包不会被当成新请求的回包。
  constructor(private proc: RpcProcess, options: { idPrefix?: string } = {}) {
    super();
    this.idPrefix = options.idPrefix ?? "plc-";
    attachJsonlReader(proc.stdout!, (line) => this.handleLine(line));
    // child 死亡时拒绝全部在途请求，否则调用方永远悬挂（stop_child 场景实测踩坑）。
    // spawn 失败（ENOENT）只触发 'error' 不触发 'exit'，两个都要收（否则 get_state 永久挂起）。
    const fail = (reason: string) => {
      if (this.exited) return;
      this.exited = true;
      for (const [, p] of this.pending) p.reject(new Error(reason));
      this.pending.clear();
    };
    proc.on("exit", () => fail("child process exited"));
    proc.on("error", () => fail("child process spawn error"));
    proc.stdin?.on("error", () => { /* EPIPE on dead child: swallow, fail() handles pending */ });
  }

  send(cmd: Record<string, unknown>): Promise<RpcResponse> {
    const id = `${this.idPrefix}${this.nextId++}`;
    return new Promise((resolve, reject) => {
      if (this.exited || this.proc.stdin!.destroyed) {
        reject(new Error("child process exited"));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(JSON.stringify({ ...cmd, id }) + "\n");
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { this.emit("parse_error", line); return; }
    // 每个回包都在交付这一行时同步报告，在请求的 promise 兑现之前（工单 15）。
    // 所以由回包产生的事件和其他事件的先后只取决于输出，从头重放时 seq 不会错位。
    if (msg.type === "response") this.emit("response", msg);
    if (msg.type === "response" && msg.id && this.pending.has(msg.id)) {
      this.pending.get(msg.id)!.resolve(msg);
      this.pending.delete(msg.id);
    } else {
      this.emit("event", msg);
    }
  }
}
