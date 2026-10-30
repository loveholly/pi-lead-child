// 桌面通知的出口。没有客户端连着时，daemon 用 osascript 在 macOS 上弹系统通知。
// 测试起的是真实 daemon。以前每跑一次测试，用户桌面上都会弹出真实的 blocker 通知。
// 根 vitest 配置设置 PLC_DESKTOP_NOTIFY=off，让测试里的 daemon 不弹通知。
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { openDb, type Db } from "@pi-lead-child/store";
import { addNotification, getNotification } from "@pi-lead-child/store";

// 这个文件里的 osascript 调用只记录，不执行，所以红的时候也不会弹通知。其他命令照常执行。
const osascript = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = (file: string, ...rest: unknown[]) => {
    if (file === "osascript") {
      osascript.calls.push(rest[0] as string[]);
      return undefined;
    }
    return (actual.execFile as (...args: unknown[]) => unknown)(file, ...rest);
  };
  return { ...actual, execFile };
});

let dir: string;
let dbPath: string;
let db: Db;
beforeEach(() => {
  dir = tempDir("plc-desktop-");
  vi.stubEnv("PLC_DATA_DIR", dir);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  osascript.calls.length = 0;
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

// Lead 用 notify_user 写的一条通知，没有客户端连着：daemon 马上推到桌面。
// 2026-10-15 起（Jarvis 模式）blocker 先交给 Lead，桌面通知只在 Lead 决定推、或者 Lead 不能工作时才弹。
let noticeId = 0;
function seedLeadNotice(): string {
  const summary = "Claude Code 需要你重新登录；#12 已经换到 Codex 继续";
  noticeId = addNotification(db, { kind: "lead_notice", urgency: "immediate", title: summary, createdAt: new Date().toISOString() });
  return summary;
}

// 不调用模型的 lead session，只记下收到的 prompt。
function stubLead() {
  const prompts: string[] = [];
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe() { return () => {}; },
      async prompt(msg: string) { prompts.push(msg); },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  return { factory, prompts };
}

describe("desktop notifier", () => {
  it("does not spawn osascript from a daemon started by the test suite", async () => {
    seedLeadNotice();
    const lead = stubLead();
    const daemon = await startDaemon({
      dataDir: dir,
      dbPath,
      sessionFactory: lead.factory as never,
      log: () => {},
    });
    try {
      // 通知推出去以后记为已送达：那一步已经走过。
      await vi.waitFor(() => expect(getNotification(db, noticeId)?.state).toBe("delivered"));
      expect(osascript.calls).toEqual([]);
    } finally {
      await daemon.close();
    }
  });

  it("hands Lead's notice to the injected notifier when no client is connected", async () => {
    const summary = seedLeadNotice();
    const lead = stubLead();
    const shown: string[] = [];
    const daemon = await startDaemon({
      dataDir: dir,
      dbPath,
      sessionFactory: lead.factory as never,
      log: () => {},
      notifyDesktop: (text) => { shown.push(text); },
    });
    try {
      await vi.waitFor(() => expect(shown).toEqual([summary]));
      expect(osascript.calls).toEqual([]);
    } finally {
      await daemon.close();
    }
  });

  it("keeps osascript as the production default when the switch is not set", async () => {
    vi.stubEnv("PLC_DESKTOP_NOTIFY", undefined);
    const summary = seedLeadNotice();
    const lead = stubLead();
    const daemon = await startDaemon({
      dataDir: dir,
      dbPath,
      sessionFactory: lead.factory as never,
      log: () => {},
    });
    try {
      await vi.waitFor(() => expect(osascript.calls).toEqual([[
        "-e", `display notification ${JSON.stringify(summary)} with title "pi-lead-child"`,
      ]]));
    } finally {
      await daemon.close();
    }
  });
});
