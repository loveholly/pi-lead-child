// Hindsight 的本地模型下载（2026-10-16 用户决定：用户选了本地模型，才在后台下载）。
// 下载在 Hindsight 自己的 Python 环境里跑 hindsight-download.py：只下 sentence-transformers 要用的文件，
// 只接受 safetensors，固定到一个 commit（revision），下完从快照目录离线加载一次，确认 Hindsight 用得了。
// 进度写在 <dataDir>/hindsight/models.json：daemon 重启后，没下完的接着下（Hugging Face 的下载可以续传）。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { packageSource } from "@pi-lead-child/core";
import { HINDSIGHT_VERSION, hindsightDir, hindsightUvxArgs } from "./hindsight.js";

export type ModelKind = "embedding" | "reranker";

export interface ModelDownloadState {
  kind: ModelKind;
  state: "downloading" | "ready" | "failed";
  bytes: number;
  total: number;
  error: string | null;
  updatedAt: string;
  // 下的是哪个 commit。请求时给了就是它；没给时是下载时 main 指向的 commit。
  revision?: string | null;
  // 下好、校验过的快照目录。Hindsight 从这里离线加载。
  path?: string | null;
}

const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const REVISION = /^[0-9a-f]{40}$/;
// 下载脚本是源码：daemon 打包后也从仓库里运行它（和 pi 执行器的扩展文件一样）。
export const DOWNLOAD_SCRIPT = packageSource("supervisor", "deploy", "hindsight-download.py");

export interface ModelDownloadsOptions {
  dataDir: string;
  uvx: string | null;
  // 状态变了（开始、进度、完成、失败）时调用。进度最多一秒一次（下载脚本节流）。
  onChange: (repo: string, state: ModelDownloadState) => void;
  log?: (line: string) => void;
  // 测试注入：代替 uvx 运行的命令。
  command?: (repo: string, kind: ModelKind, revision: string | null) => { bin: string; args: string[] };
}

export class ModelDownloads {
  private readonly running = new Map<string, ChildProcess>();
  private states: Record<string, ModelDownloadState>;
  private readonly path: string;

  constructor(private readonly options: ModelDownloadsOptions) {
    this.path = join(hindsightDir(options.dataDir), "models.json");
    this.states = this.read();
  }

  private read(): Record<string, ModelDownloadState> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, ModelDownloadState>;
    } catch {
      return {};
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, `${JSON.stringify(this.states, null, 2)}\n`, { mode: 0o600 });
  }

  private set(repo: string, state: ModelDownloadState): void {
    this.states[repo] = state;
    this.save();
    this.options.onChange(repo, state);
  }

  status(repo: string): ModelDownloadState | null {
    return this.states[repo] ?? null;
  }

  // 下好了，并且（给了 revision 时）是这个 commit。
  ready(repo: string, revision: string | null = null): boolean {
    const state = this.states[repo];
    return state?.state === "ready" && Boolean(state.path) && (revision === null || state.revision === revision);
  }

  // 下好的快照：commit 和目录。没下好时是 null。
  snapshot(repo: string, revision: string | null = null): { revision: string; path: string } | null {
    const state = this.states[repo];
    return this.ready(repo, revision) && state?.revision && state.path ? { revision: state.revision, path: state.path } : null;
  }

  // 开始下载一个模型。已经下好（同一个 commit）、或者正在下时什么也不做。失败过的重新下。
  start(repo: string, kind: ModelKind, revision: string | null = null): void {
    if (!REPO.test(repo)) throw new Error(`not a Hugging Face model id: ${repo}`);
    if (revision !== null && !REVISION.test(revision)) throw new Error(`not a commit id: ${revision}`);
    if (this.ready(repo, revision) || this.running.has(repo)) return;
    const command = this.options.command?.(repo, kind, revision) ?? (this.options.uvx ? {
      bin: this.options.uvx,
      args: [
        ...hindsightUvxArgs(), "--from", `hindsight-api@${HINDSIGHT_VERSION}`, "python", "-I", DOWNLOAD_SCRIPT, repo, kind,
        ...(revision ? [revision] : []),
      ],
    } : null);
    const previous = this.states[repo];
    if (!command) {
      this.set(repo, { kind, state: "failed", bytes: 0, total: previous?.total ?? 0, error: "uvx not found; install uv to download local models", updatedAt: new Date().toISOString() });
      return;
    }
    this.set(repo, {
      kind, state: "downloading", bytes: previous?.bytes ?? 0, total: previous?.total ?? 0, error: null,
      updatedAt: new Date().toISOString(), revision, path: null,
    });
    this.options.log?.(`[hindsight] downloading ${repo}`);
    const child = spawn(command.bin, command.args, { stdio: ["ignore", "pipe", "pipe"] });
    this.running.set(repo, child);
    let buffered = "";
    let stderrTail = "";
    let finished = false;
    const update = (patch: Partial<ModelDownloadState>) => {
      const current = this.states[repo]!;
      this.set(repo, { ...current, ...patch, updatedAt: new Date().toISOString() });
    };
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        let event: { event?: string; total?: number; bytes?: number; message?: string; revision?: unknown; path?: unknown };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.event === "start" && typeof event.total === "number") {
          update({ total: event.total, ...(typeof event.revision === "string" && REVISION.test(event.revision) ? { revision: event.revision } : {}) });
        }
        else if (event.event === "progress" && typeof event.bytes === "number") {
          update({ bytes: event.bytes, ...(typeof event.total === "number" ? { total: event.total } : {}) });
        } else if (event.event === "verified") {
          finished = true;
          const total = this.states[repo]!.total;
          const verifiedRevision = typeof event.revision === "string" && REVISION.test(event.revision) ? event.revision : null;
          const path = typeof event.path === "string" && event.path.startsWith("/") ? event.path : null;
          if (!verifiedRevision || !path || (revision !== null && verifiedRevision !== revision)) {
            update({ state: "failed", error: "the download did not report the pinned commit and its directory" });
          } else {
            update({ state: "ready", bytes: total, error: null, revision: verifiedRevision, path });
            this.options.log?.(`[hindsight] downloaded and verified ${repo}@${verifiedRevision.slice(0, 12)}`);
          }
        } else if (event.event === "error") {
          finished = true;
          update({ state: "failed", error: String(event.message ?? "download failed").slice(0, 400) });
          this.options.log?.(`[hindsight] download of ${repo} failed: ${event.message}`);
        }
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-400); });
    child.on("error", (error) => {
      this.running.delete(repo);
      if (!finished) update({ state: "failed", error: `cannot start the download: ${error.message}` });
    });
    child.on("exit", (code, signal) => {
      this.running.delete(repo);
      // 被 daemon 停掉（关机）：状态留在 downloading，下次启动接着下。
      if (finished || signal === "SIGTERM") return;
      update({ state: "failed", error: `download exited with ${signal ?? code}${stderrTail ? `: ${stderrTail.trim().split("\n").at(-1)}` : ""}` });
    });
  }

  // daemon 启动时：上次没下完的接着下。
  resume(): void {
    for (const [repo, state] of Object.entries(this.states)) {
      if (state.state === "downloading") this.start(repo, state.kind, state.revision ?? null);
    }
  }

  // daemon 关机时：停掉正在跑的下载，状态留在 downloading。
  stopAll(): void {
    for (const child of this.running.values()) child.kill("SIGTERM");
  }
}
