// 宿主探针（lead-scheduler spec D7、D12）：线程池被占满、主线程被同步调用卡住时，日志能说出来。
import { closeSync, openSync, readFileSync } from "node:fs";
import { pbkdf2 } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeHostLoad, hostProbeSnapshot, startHostProbes, trackHostJob, type HostProbes } from "../src/index.js";
import { tempDir } from "../testing/index.js";

let probes: HostProbes | null = null;
afterEach(() => {
  probes?.stop();
  probes = null;
});

// 占满 I/O 线程池（缺省 4 个线程）：pbkdf2 在线程池里算。
function occupyThreadpool(ms: number): Promise<void[]> {
  const iterations = Math.max(1, Math.round(ms * 1_500));
  return Promise.all(Array.from({ length: 8 }, () => new Promise<void>((resolve) => {
    pbkdf2("p", "s", iterations, 32, "sha256", () => resolve());
  })));
}

describe("host probes", () => {
  it("says the threadpool is busy and names the background job that runs", async () => {
    const lines: string[] = [];
    probes = startHostProbes({ log: (line) => lines.push(line), dir: tempDir("plc-host-probes-"), workerFd: null, poolEveryMs: 50, poolWarnMs: 200 });
    await vi.waitFor(() => expect(hostProbeSnapshot()?.pool.lastMs).not.toBeNull());

    await trackHostJob("worktree-delete", "workspace #3", () => occupyThreadpool(1_500));

    const busy = lines.find((line) => line.includes("probe.pool_busy"));
    expect(busy).toMatch(/^\[sched\] probe\.pool_busy waitingMs=\d+ thresholdMs=200 jobs="worktree-delete#\d+\(workspace #3, \d+s\)"$/);
    await vi.waitFor(() => expect(lines.some((line) => line.includes("probe.pool_recovered"))).toBe(true));
    expect(describeHostLoad()).toMatch(/^pool="(last|waiting) \d+ms" loopMax=\d+ms jobs="none"$/);
  }, 30_000);

  it("notices from a worker that the main thread is blocked, while it is blocked", async () => {
    const dir = tempDir("plc-host-probes-");
    const file = join(dir, "daemon.log");
    const fd = openSync(file, "a");
    const lines: string[] = [];
    try {
      probes = startHostProbes({ log: (line) => lines.push(line), dir, workerFd: fd, blockedMs: 300, lagWarnMs: 300 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const end = Date.now() + 1_500;
      while (Date.now() < end) { /* the main thread is stuck in a synchronous call */ }
      // 卡住的时候主线程写不了日志：worker 那一行已经在文件里了。
      expect(readFileSync(file, "utf8")).toMatch(/\[sched\] probe\.main_blocked silentMs=\d+ thresholdMs=300 source=worker/);
      await vi.waitFor(() => expect(lines.some((line) => /^\[sched\] probe\.main_lag lateMs=\d+/.test(line))).toBe(true));
    } finally {
      probes?.stop();
      probes = null;
      closeSync(fd);
    }
  }, 20_000);

  it("stops cleanly and reports no probes afterwards", () => {
    probes = startHostProbes({ log: () => {}, dir: tempDir("plc-host-probes-"), workerFd: null });
    expect(hostProbeSnapshot()).not.toBeNull();
    probes.stop();
    probes = null;
    expect(hostProbeSnapshot()).toBeNull();
    expect(describeHostLoad()).toBe("probes=off jobs=none");
  });
});
