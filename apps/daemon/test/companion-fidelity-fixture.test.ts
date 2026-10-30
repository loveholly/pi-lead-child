import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "@pi-lead-child/store";
import { createControlPlaneService } from "@pi-lead-child/gateway";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  FIDELITY_PROTOTYPE_SHA256,
  FIDELITY_SCENARIOS,
  seedCompanionFidelity,
} from "../scripts/seed-companion-fidelity.js";
import {
  FIDELITY_GATEWAY_HOST,
  FIDELITY_LOOPBACK_ORIGIN,
  startCompanionFidelityGateway,
} from "../scripts/serve-companion-fidelity-gateway.js";
// @ts-expect-error Acceptance helpers are executable .mjs modules, not typed product APIs.
import { verifyPrototypeFile } from "../scripts/serve-companion-prototype.mjs";
// @ts-expect-error Acceptance helpers are executable .mjs modules, not typed product APIs.
import { ACCEPTANCE_PORTS, createProcessSpecs, startAcceptanceDaemon, startAcceptanceSession, stopAcceptanceDaemon, stopAcceptanceSession } from "../scripts/run-companion-fidelity-acceptance.mjs";
// @ts-expect-error Acceptance helpers are executable .mjs modules, not typed product APIs.
import { comparisonOutputBasenames, createCompanionFidelityComparison } from "../scripts/create-companion-fidelity-comparison.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");

interface FixtureRuntime {
  seed(input: { scenario: string; dataDir: string; repoRoot: string }): Promise<unknown>;
  spawn(input: unknown): Promise<EventEmitter & { pid: number }>;
  waitReady(input: unknown, process: unknown): Promise<void>;
  stop(pid: number): Promise<void>;
  healthAvailable(url: string): Promise<boolean>;
  now(): string;
}

interface FixtureSessionProcess {
  state: string;
}

function tableCount(dbPath: string, table: string): number {
  const db = openDb(dbPath);
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function tableCounts<T extends string>(dbPath: string, tables: readonly T[]): Record<T, number> {
  const db = openDb(dbPath);
  try {
    return Object.fromEntries(tables.map((table) => [
      table,
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    ])) as Record<T, number>;
  } finally {
    db.close();
  }
}

const FIDELITY_DOMAIN_TABLES = [
  "items",
  "runs",
  "activities",
  "checkpoints",
  "item_proof_items",
  "artifacts",
  "runtime_events",
  "approvals",
  "inbox",
  "channel_turns",
  "conversation_cards",
] as const;

function domainSnapshot(dbPath: string): Record<string, unknown[]> {
  const db = openDb(dbPath);
  try {
    return Object.fromEntries(FIDELITY_DOMAIN_TABLES.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]));
  } finally {
    db.close();
  }
}

describe("deterministic Companion fidelity fixture", () => {
  it("seeds populated data once with progress, three proof states, children, artifacts, logs, and intervention", () => {
    const dataDir = tempDir("plc-fidelity-populated-");
    const first = seedCompanionFidelity({ dataDir, scenario: "populated" });
    const rawCounts = tableCounts(first.dbPath, [
      "items",
      "checkpoints",
      "item_proof_items",
      "artifacts",
      "runtime_events",
      "approvals",
      "channel_turns",
      "conversation_cards",
    ] as const);
    const counts = {
      items: rawCounts.items,
      checkpoints: rawCounts.checkpoints,
      proof: rawCounts.item_proof_items,
      artifacts: rawCounts.artifacts,
      events: rawCounts.runtime_events,
      approvals: rawCounts.approvals,
      turns: rawCounts.channel_turns,
      conversationCards: rawCounts.conversation_cards,
    };

    expect(FIDELITY_SCENARIOS).toEqual(["populated", "first-use", "all-completed", "no-results"]);
    expect(first.scenario).toBe("populated");
    expect(first.expectedWorkspaceState).toMatchObject({
      rail: "populated",
      filter: "all",
      searchQuery: "",
      selectedItemId: first.itemIds.primary,
    });
    expect(Object.values(first.itemIds).filter((value) => value !== null).length).toBeGreaterThanOrEqual(5);
    expect(Object.values(first.artifactIds)).toHaveLength(3);
    expect(first.expectedSelectors).toEqual(expect.arrayContaining([
      "workbench",
      "work-rail",
      "lead-conversation",
      "ticket-thread",
      "compact-nav",
      "pow-panel",
      "artifact-list",
      "log-timeline",
      `artifact-download-${first.artifactIds.downloadable}`,
      `artifact-retry-${first.artifactIds.downloadable}`,
      `artifact-cancel-${first.artifactIds.downloadable}`,
    ]));
    expect(counts).toMatchObject({ proof: 3, artifacts: 3, approvals: 1 });
    expect(counts.turns).toBe(2);
    expect(counts.conversationCards).toBeGreaterThanOrEqual(2);
    expect(counts.items).toBeGreaterThanOrEqual(5);
    expect(counts.checkpoints).toBeGreaterThanOrEqual(2);
    expect(counts.events).toBeGreaterThanOrEqual(6);

    const db = openDb(first.dbPath);
    try {
      expect(first.itemIds).toMatchObject({
        blockedChild: 38,
        secondary: 41,
        primary: 42,
        tertiary: 55,
      });
      expect(first.runIds.primary).toBe(73);
      expect(db.prepare(
        "SELECT progress_current, progress_total, progress_label FROM checkpoints WHERE item_id=? AND progress_current IS NOT NULL ORDER BY id DESC LIMIT 1",
      ).get(first.itemIds.primary)).toEqual({
        progress_current: 8,
        progress_total: 13,
        progress_label: "验收步骤",
      });
      expect(db.prepare(
        "SELECT key_facts FROM checkpoints WHERE item_id=? AND progress_current IS NOT NULL ORDER BY id DESC LIMIT 1",
      ).get(first.itemIds.primary)).toEqual({
        key_facts: JSON.stringify([
          { label: "能力覆盖", value: "11/14" },
          { label: "发现缺口", value: "3" },
        ]),
      });
      expect(db.prepare(
        "SELECT state FROM item_proof_items WHERE item_id=? ORDER BY proof_key",
      ).all(first.itemIds.primary)).toEqual([
        { state: "passed" },
        { state: "passed" },
        { state: "pending" },
      ]);
      expect(db.prepare(
        "SELECT id, title, stage, priority, project FROM items WHERE parent_item_id IS NULL ORDER BY id",
      ).all()).toEqual([
        { id: 38, title: "迁移 daemon 到常开机器", stage: "blocked", priority: "low", project: "常开机器迁移" },
        { id: 41, title: "M9 launchd 真机验收", stage: "review", priority: "normal", project: "常开机器迁移" },
        { id: 42, title: "移动控制面协议缺口审计", stage: "active", priority: "high", project: "移动控制面 GA" },
        { id: 55, title: "周报自动化汇总", stage: "review", priority: "normal", project: "周报自动化" },
      ]);
      expect(db.prepare(
        "SELECT title, stage FROM items WHERE parent_item_id=? ORDER BY id",
      ).all(first.itemIds.primary)).toEqual([
        { title: "枚举控制面能力", stage: "done" },
        { title: "比对 paired API", stage: "done" },
        { title: "验证鉴权边界", stage: "active" },
      ]);
      expect(db.prepare(
        "SELECT ref, availability FROM artifacts WHERE item_id=? ORDER BY ref",
      ).all(first.itemIds.primary)).toEqual([
        { ref: "acceptance-report", availability: "available" },
        { ref: "legacy-reference", availability: "metadata_only" },
        { ref: "missing-export", availability: "unavailable" },
      ]);
      expect(db.prepare(
        "SELECT state, user_text, assistant_text, created_at, updated_at FROM channel_turns WHERE item_id=? ORDER BY created_at",
      ).all(first.itemIds.primary)).toEqual([
        {
          state: "completed",
          user_text: "把移动控制面拆成能落地的计划，让 child 先做协议缺口审计。",
          assistant_text: "已建好工单 #42，child 开工啦。我把后续都绑到 #42，但仍写在同一个 Lead 长会话里。",
          created_at: "2026-07-25T07:38:00.000Z",
          updated_at: "2026-07-25T07:38:00.000Z",
        },
        {
          state: "completed",
          user_text: "",
          assistant_text: "你可以在这儿继续调方向，也能打开右侧线程，只围绕 #42 补上下文。",
          created_at: "2026-07-25T07:41:00.000Z",
          updated_at: "2026-07-25T07:41:00.000Z",
        },
      ]);
      expect(db.prepare(
        "SELECT kind, payload FROM conversation_cards WHERE turn_id='companion-fidelity-turn'",
      ).get()).toEqual(expect.objectContaining({
        kind: "ticket_execution",
        payload: expect.stringContaining("spawn_child"),
      }));
      expect(db.prepare(
        "SELECT key_facts FROM checkpoints WHERE item_id=? AND action_type='approval'",
      ).get(first.itemIds.blockedChild)).toEqual({
        key_facts: JSON.stringify([
          { label: "stderr", value: "Operation not permitted: /Library/LaunchDaemons" },
        ]),
      });
    } finally {
      db.close();
    }

    const second = seedCompanionFidelity({ dataDir, scenario: "populated" });
    expect(second).toEqual(first);
    const repeatedCounts = tableCounts(first.dbPath, [
      "items",
      "checkpoints",
      "item_proof_items",
      "artifacts",
      "runtime_events",
      "approvals",
      "channel_turns",
      "conversation_cards",
    ] as const);
    expect({
      items: repeatedCounts.items,
      checkpoints: repeatedCounts.checkpoints,
      proof: repeatedCounts.item_proof_items,
      artifacts: repeatedCounts.artifacts,
      events: repeatedCounts.runtime_events,
      approvals: repeatedCounts.approvals,
      turns: repeatedCounts.channel_turns,
      conversationCards: repeatedCounts.conversation_cards,
    }).toEqual(counts);
  });

  it("seeds the prototype review and blocked ticket trees without attaching #55 to #38", () => {
    const fixture = seedCompanionFidelity({
      dataDir: tempDir("plc-fidelity-ticket-trees-"),
      scenario: "populated",
    });
    const db = openDb(fixture.dbPath);
    try {
      expect(db.prepare(
        `SELECT id, state, external_session_id, session_id
         FROM runs WHERE item_id=? ORDER BY id DESC LIMIT 1`,
      ).get(fixture.itemIds.secondary)).toEqual({
        id: 71,
        state: "running",
        external_session_id: "sess_71b0e4d2",
        session_id: "sess_71b0e4d2",
      });
      expect(db.prepare(
        `SELECT title, stage, parent_item_id, root_item_id, project
         FROM items WHERE parent_item_id=? ORDER BY id`,
      ).all(fixture.itemIds.secondary)).toEqual([
        {
          title: "打包 launchd plist",
          stage: "done",
          parent_item_id: fixture.itemIds.secondary,
          root_item_id: fixture.itemIds.secondary,
          project: null,
        },
        {
          title: "真机安装冒烟",
          stage: "done",
          parent_item_id: fixture.itemIds.secondary,
          root_item_id: fixture.itemIds.secondary,
          project: null,
        },
      ]);
      expect(db.prepare(
        `SELECT title, stage, parent_item_id, root_item_id, project
         FROM items WHERE parent_item_id=? ORDER BY id`,
      ).all(fixture.itemIds.blockedChild)).toEqual([
        {
          title: "探测目标机环境",
          stage: "done",
          parent_item_id: fixture.itemIds.blockedChild,
          root_item_id: fixture.itemIds.blockedChild,
          project: null,
        },
        {
          title: "安装 launchd 服务",
          stage: "blocked",
          parent_item_id: fixture.itemIds.blockedChild,
          root_item_id: fixture.itemIds.blockedChild,
          project: null,
        },
      ]);

      const weekly = db.prepare(
        "SELECT id, parent_item_id, root_item_id, project, project_id FROM items WHERE id=?",
      ).get(fixture.itemIds.tertiary) as {
        id: number;
        parent_item_id: number | null;
        root_item_id: number;
        project: string;
        project_id: number;
      };
      const blocked = db.prepare(
        "SELECT project_id FROM items WHERE id=?",
      ).get(fixture.itemIds.blockedChild) as { project_id: number };
      expect(weekly).toMatchObject({
        id: 55,
        parent_item_id: null,
        root_item_id: 55,
        project: "周报自动化",
      });
      expect(weekly.project_id).not.toBe(blocked.project_id);
      expect(db.prepare(
        "SELECT title, brief FROM items WHERE parent_item_id=? ORDER BY id",
      ).all(fixture.itemIds.primary)).toEqual([
        { title: "枚举控制面能力", brief: "对照 spec 列出完整控制面所需的 14 项能力，逐项定位来源。" },
        { title: "比对 paired API", brief: "将 14 项能力与当前 paired API 覆盖度比对，标出缺口。" },
        { title: "验证鉴权边界", brief: "验证 chat/status 的鉴权边界可读性，需放开 approvals。" },
      ]);

      const controlPlane = createControlPlaneService(db, {
        runtime: () => ({
          model: "companion-fidelity",
          sessionId: "companion-fidelity",
          busy: false,
          runningItemIds: [],
          aish: null,
        }),
        now: () => new Date("2026-07-25T07:44:12.000Z"),
      });
      // 项目的数字和按项目筛选后的工单 tab 一样（ticketTurn）：根工单，加上需要你的子工单。
      // 移动控制面 GA 的三张子工单不需要你，不算；常开机器迁移的「安装 launchd 服务」阻塞着，算，
      // 它没有项目名，跟着根工单走。等你验收的 #41、#55 算在「等你」（blockedCount）里。
      expect(controlPlane.listProjects()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "移动控制面 GA", ticketCount: 1, runningCount: 1, blockedCount: 0 }),
        expect.objectContaining({ name: "常开机器迁移", ticketCount: 3, blockedCount: 3 }),
        expect.objectContaining({ name: "周报自动化", ticketCount: 1, runningCount: 0, blockedCount: 1 }),
      ]));
      expect(controlPlane.listProjects()).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "unknown" }),
      ]));
      expect(controlPlane.getKernelTicketWorkbenchV2(fixture.itemIds.validationChild!)).toMatchObject({
        activeAttempt: { id: 75, state: "running" },
        progress: { current: 11, total: 20, percent: 55 },
      });
    } finally {
      db.close();
    }
  });

  it("seeds the four prototype agenda events in the current Asia/Shanghai week", () => {
    const fixture = seedCompanionFidelity({
      dataDir: tempDir("plc-fidelity-agenda-"),
      scenario: "populated",
    });
    const db = openDb(fixture.dbPath);
    try {
      const controlPlane = createControlPlaneService(db, {
        runtime: () => ({
          model: "companion-fidelity",
          sessionId: "companion-fidelity",
          busy: false,
          runningItemIds: [],
          aish: null,
        }),
        now: () => new Date("2026-07-27T02:00:00.000Z"),
      });
      expect(controlPlane.agenda({
        from: "2026-07-27T00:00:00+08:00",
        to: "2026-08-03T00:00:00+08:00",
        timezone: "Asia/Shanghai",
      })).toEqual([
        expect.objectContaining({
          kind: "schedule",
          startsAt: "2026-07-27T02:00:00.000Z",
          title: "移动控制面协议评审",
          description: "与 #42 关联",
          project: "移动控制面 GA",
        }),
        expect.objectContaining({
          kind: "schedule",
          startsAt: "2026-07-28T06:00:00.000Z",
          title: "M9 真机验收窗口",
          description: "#41 待验收",
          project: "常开机器迁移",
        }),
        expect.objectContaining({
          kind: "schedule",
          startsAt: "2026-07-30T03:00:00.000Z",
          title: "daemon 迁移复盘",
          description: "#38 解阻后",
          project: "常开机器迁移",
        }),
        expect.objectContaining({
          kind: "schedule",
          startsAt: "2026-07-31T08:00:00.000Z",
          title: "周报交付",
          description: "#55 · 自动汇总",
          project: "周报自动化",
        }),
      ]);
      // schedules 已被 triggers 吸收（spec §5.6）；例行条目的载体换了，内容不变。
      expect(db.prepare(
        "SELECT label, json_extract(action_payload, '$.brief') AS brief FROM triggers ORDER BY id",
      ).all()).toEqual([
        { label: "移动控制面协议评审", brief: "与 #42 关联" },
        { label: "M9 真机验收窗口", brief: "#41 待验收" },
        { label: "daemon 迁移复盘", brief: "#38 解阻后" },
        { label: "周报交付", brief: "#55 · 自动汇总" },
      ]);
    } finally {
      db.close();
    }
  });

  it("seeds isolated first-use, all-completed, and no-results workspace states", () => {
    const firstUse = seedCompanionFidelity({
      dataDir: tempDir("plc-fidelity-first-use-"),
      scenario: "first-use",
    });
    expect(tableCount(firstUse.dbPath, "items")).toBe(0);
    expect(firstUse.expectedWorkspaceState).toMatchObject({ rail: "first_use", filter: "all" });

    const completed = seedCompanionFidelity({
      dataDir: tempDir("plc-fidelity-completed-"),
      scenario: "all-completed",
    });
    const completedDb = openDb(completed.dbPath);
    try {
      expect(completed.expectedWorkspaceState).toMatchObject({ rail: "all_completed", filter: "all" });
      expect(completedDb.prepare(
        "SELECT stage FROM items ORDER BY id",
      ).all()).toEqual([{ stage: "done" }, { stage: "done" }, { stage: "done" }]);
    } finally {
      completedDb.close();
    }

    const noResults = seedCompanionFidelity({
      dataDir: tempDir("plc-fidelity-no-results-"),
      scenario: "no-results",
    });
    expect(tableCount(noResults.dbPath, "items")).toBeGreaterThan(0);
    expect(noResults.expectedWorkspaceState).toMatchObject({
      rail: "no_results",
      filter: "todo",
      searchQuery: "fixture-query-with-no-matches",
    });
  });

  it("locks prototype hash and exact managed child contracts to fixed ports", () => {
    expect(FIDELITY_PROTOTYPE_SHA256).toBe(
      "246337627a539e859330447ab3415b94a8d6cf206b9996b2e8368ebd37c6b3a9",
    );
    expect(ACCEPTANCE_PORTS).toEqual({ daemon: 47140, expo: 49161, prototype: 49162 });
    const dataDir = "/tmp/plc-fidelity-contract";
    const prototypePath = "/tmp/1-Lead-Child.html";
    const specs = createProcessSpecs({ repoRoot, dataDir, prototypePath });
    expect(specs.daemon).toMatchObject({
      command: process.execPath,
      args: [
        "--import", "tsx",
        "apps/daemon/scripts/serve-companion-fidelity-gateway.ts",
        "--data-dir", dataDir,
        "--port", "47140",
        "--host", "127.0.0.1",
        "--origin", "http://localhost:49161",
      ],
      cwd: repoRoot,
      env: {
        PLC_DATA_DIR: dataDir,
        PLC_GATEWAY_PORT: "47140",
        PLC_GATEWAY_HOST: "127.0.0.1",
        PLC_ALLOW_LOOPBACK_AUTO_PAIR: "1",
        PLC_LOOPBACK_AUTO_PAIR_ORIGINS: "http://localhost:49161",
      },
    });
    expect(specs.expo).toMatchObject({
      command: "npx",
      args: ["expo", "start", "--web", "--port", "49161", "--clear"],
      cwd: join(repoRoot, "apps", "companion"),
      env: {
        CI: "1",
        EXPO_PUBLIC_PLC_GATEWAY_URL: "http://127.0.0.1:47140",
      },
    });
    expect(specs.prototype).toMatchObject({
      command: process.execPath,
      args: [
        "apps/daemon/scripts/serve-companion-prototype.mjs",
        "--port", "49162",
        "--file", prototypePath,
        "--sha256", FIDELITY_PROTOTYPE_SHA256,
      ],
      cwd: repoRoot,
    });
  });

  it("serves the populated fixture without daemon recovery or intervention expiry mutations", async () => {
    const dataDir = tempDir("plc-fidelity-gateway-");
    const fixture = seedCompanionFidelity({ dataDir, scenario: "populated" });
    const before = domainSnapshot(fixture.dbPath);
    expect(before.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "running" }),
      expect.objectContaining({ state: "running" }),
    ]));
    expect(before.approvals).toEqual([
      expect.objectContaining({ status: "pending" }),
    ]);

    const loopbackOrigin = "http://127.0.0.1:8081";
    const gateway = await startCompanionFidelityGateway({
      dataDir,
      port: 0,
      host: FIDELITY_GATEWAY_HOST,
      loopbackAutoPairOrigins: [loopbackOrigin],
      log: () => {},
    });
    try {
      const base = `http://${FIDELITY_GATEWAY_HOST}:${gateway.port}`;
      expect((await fetch(`${base}/v1/health`)).status).toBe(200);

      const paired = await fetch(`${base}/v1/paired/loopback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: loopbackOrigin },
        body: JSON.stringify({ name: "fidelity-test" }),
      });
      expect(paired.status).toBe(201);
      const pairing = await paired.json() as { access_token: string };
      const ticketResponse = await fetch(`${base}/v1/tickets`, {
        headers: { authorization: `Bearer ${pairing.access_token}` },
      });
      expect(ticketResponse.status).toBe(200);
      const { items: tickets } = await ticketResponse.json() as { items: Array<{
          title: string;
          parentTicketId?: number | null;
          rootTicketId?: number;
          runtime: { state: string };
        }> };
      expect(tickets.find((ticket) => ticket.title === "移动控制面协议缺口审计")).toMatchObject({
        parentTicketId: null,
        runtime: { state: "running" },
      });
      expect(tickets.find((ticket) => ticket.title === "验证鉴权边界")).toMatchObject({
        parentTicketId: fixture.itemIds.primary,
        rootTicketId: fixture.itemIds.primary,
      });
      const wrongOrigin = await fetch(`${base}/v1/paired/loopback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: FIDELITY_LOOPBACK_ORIGIN },
        body: JSON.stringify({ name: "wrong-origin" }),
      });
      expect(wrongOrigin.status).toBe(403);

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_250));
      expect(domainSnapshot(fixture.dbPath)).toEqual(before);

      const source = readFileSync(
        join(repoRoot, "apps", "daemon", "scripts", "serve-companion-fidelity-gateway.ts"),
        "utf8",
      );
      expect(source).toContain('host: input.host ?? FIDELITY_GATEWAY_HOST');
      expect(source).toContain('allowLoopbackAutoPair: true');
      expect(source).toContain('loopbackAutoPairOrigins: input.loopbackAutoPairOrigins ?? [FIDELITY_LOOPBACK_ORIGIN]');
      expect(source).toMatch(/chatV2:\s*\(\)\s*=>\s*\{[\s\S]*PairedCommandError\("forbidden"/);
    } finally {
      await gateway.close();
    }
  }, 10_000);

  it("refuses prototype bytes whose SHA-256 does not match", () => {
    const dir = tempDir("plc-fidelity-prototype-");
    const file = join(dir, "prototype.html");
    writeFileSync(file, "<!doctype html><title>fixture</title>");
    expect(() => verifyPrototypeFile(file, FIDELITY_PROTOTYPE_SHA256)).toThrow(/SHA-256 mismatch/);
    const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
    expect(verifyPrototypeFile(file, actual)).toMatchObject({ file, sha256: actual });
  });

  it("covers managed start, daemon stop/start, and full stop with atomic session updates", async () => {
    const dataDir = tempDir("plc-fidelity-lifecycle-");
    const sessionPath = join(dataDir, "session.json");
    let nextPid = 8100;
    const alive = new Set<number>();
    const stopped: number[] = [];
    const runtime: FixtureRuntime = {
      seed: async () => ({ scenario: "populated" }),
      spawn: async () => {
        const child = new EventEmitter() as EventEmitter & { pid: number };
        child.pid = nextPid++;
        alive.add(child.pid);
        return child;
      },
      waitReady: async () => {},
      stop: async (pid: number) => {
        stopped.push(pid);
        alive.delete(pid);
      },
      healthAvailable: async () => [...alive].some((pid) => pid === 8100 || pid >= 8103),
      now: (() => {
        let tick = 0;
        return () => `2026-07-25T08:00:0${tick++}.000Z`;
      })(),
    };
    const prototypePath = join(dataDir, "prototype.html");
    writeFileSync(prototypePath, "fixture");

    const started = await startAcceptanceSession({
      scenario: "populated",
      prototypePath,
      sessionPath,
      dataDir,
      repoRoot,
    }, runtime);
    expect(started.processes.daemon.pid).toBe(8100);
    expect(started.processes.expo.pid).toBe(8101);
    expect(started.processes.prototype.pid).toBe(8102);
    expect(readFileSync(sessionPath, "utf8")).toContain('"state": "running"');

    const daemonStopped = await stopAcceptanceDaemon(sessionPath, runtime);
    expect(daemonStopped.processes.daemon.state).toBe("stopped");
    expect(stopped).toEqual([8100]);

    const daemonRestarted = await startAcceptanceDaemon(sessionPath, runtime);
    expect(daemonRestarted.processes.daemon).toMatchObject({ pid: 8103, state: "running" });

    const allStopped = await stopAcceptanceSession(sessionPath, runtime);
    expect(Object.values(allStopped.processes as Record<string, FixtureSessionProcess>)
      .every((process) => process.state === "stopped")).toBe(true);
    expect(stopped).toEqual([8100, 8103, 8101, 8102]);
  });

  it("creates desktop/mobile side-by-side and overlay pages without changing PNG inputs", () => {
    const dir = tempDir("plc-fidelity-comparison-");
    const pngs = [
      "desktop-implementation.png",
      "desktop-reference.png",
      "mobile-implementation.png",
      "mobile-reference.png",
    ];
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    for (const name of pngs) writeFileSync(join(dir, name), original);
    const before = pngs.map((name) => statSync(join(dir, name)).mtimeMs);

    const outputs = createCompanionFidelityComparison(dir);
    expect((outputs as string[]).map((file: string) => file.split("/").at(-1))).toEqual([
      "desktop-side-by-side.html",
      "desktop-overlay.html",
      "mobile-side-by-side.html",
      "mobile-overlay.html",
    ]);
    expect(comparisonOutputBasenames(outputs)).toEqual([
      "desktop-side-by-side.html",
      "desktop-overlay.html",
      "mobile-side-by-side.html",
      "mobile-overlay.html",
    ]);
    expect(readFileSync(join(dir, "desktop-overlay.html"), "utf8")).toContain("opacity: .5");
    for (const name of pngs) expect(readFileSync(join(dir, name))).toEqual(original);
    expect(pngs.map((name) => statSync(join(dir, name)).mtimeMs)).toEqual(before);
  });
});
