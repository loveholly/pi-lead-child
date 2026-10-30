import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCoordinator } from "@pi-lead-child/engine";
import { createRun, updateRun } from "@pi-lead-child/store";
import { listArtifacts, stageArtifact } from "@pi-lead-child/store";
import { upsertItemExecutionCard } from "@pi-lead-child/store";
import { appendAssistantDelta, completeTurn, createTurn } from "@pi-lead-child/store";
import { openDb } from "@pi-lead-child/store";
import { createRuntimeEventStore } from "@pi-lead-child/store";
import { createCronTrigger } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import type { RuntimeEvent } from "@pi-lead-child/runtime";

export const FIDELITY_PROTOTYPE_SHA256 =
  "246337627a539e859330447ab3415b94a8d6cf206b9996b2e8368ebd37c6b3a9";
export const FIDELITY_SCENARIOS = [
  "populated",
  "first-use",
  "all-completed",
  "no-results",
] as const;

export type FidelityScenario = typeof FIDELITY_SCENARIOS[number];

export interface CompanionFidelityManifest {
  version: 1;
  fixture: "companion-fidelity";
  scenario: FidelityScenario;
  seededAt: string;
  dataDir: string;
  dbPath: string;
  itemIds: {
    primary: number | null;
    completedChild: number | null;
    runningChild: number | null;
    validationChild: number | null;
    blockedChild: number | null;
    secondary: number | null;
    tertiary: number | null;
  };
  runIds: { primary: number | null };
  artifactIds: {
    downloadable: number | null;
    metadataOnly: number | null;
    unavailable: number | null;
  };
  interventionIds: { approval: number | null };
  expectedSelectors: string[];
  expectedWorkspaceState: {
    rail: "populated" | "first_use" | "all_completed" | "no_results";
    destination: "items";
    filter: "all" | "todo";
    searchQuery: string;
    selectedItemId: number | null;
  };
}

const SEEDED_AT = "2026-07-25T07:38:00.000Z";
const FIXTURE_FILE = "companion-fidelity-fixture.json";

const BASE_SELECTORS = ["workbench", "work-rail", "lead-conversation", "compact-nav"];
const ITEM_SELECTORS = ["ticket-thread", "pow-panel", "artifact-list", "log-timeline"];

function atomicWriteJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function emptyIds() {
  return {
    itemIds: {
      primary: null,
      completedChild: null,
      runningChild: null,
      validationChild: null,
      blockedChild: null,
      secondary: null,
      tertiary: null,
    },
    runIds: { primary: null },
    artifactIds: { downloadable: null, metadataOnly: null, unavailable: null },
    interventionIds: { approval: null },
  };
}

function setItemDates(db: ReturnType<typeof openDb>, itemId: number, offsetMinutes: number): void {
  const at = new Date(Date.parse(SEEDED_AT) + offsetMinutes * 60_000).toISOString();
  db.prepare(
    `UPDATE items
     SET created_at=?, updated_at=?, stage_changed_at=?,
         last_activity_at=COALESCE(last_activity_at, ?)
     WHERE id=?`,
  ).run(at, at, at, at, itemId);
}

function setAutoIncrement(db: ReturnType<typeof openDb>, table: "items" | "runs", sequence: number): void {
  db.prepare("DELETE FROM sqlite_sequence WHERE name=?").run(table);
  db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)").run(table, sequence);
}

// 夹具没有单一 actor 能走完整条路径（spec §6.4）：draft → ready 只有 user，
// active → review / blocked 反过来只有 system 与 child。所以按边选 actor，
// 而不是找一个"万能身份"——后者恰恰是这次要拆掉的 lead: () => true。
// lead 建的单生于 draft，先替用户补一步确认，否则第一条边就走不通。
function advanceItem(
  db: ReturnType<typeof openDb>,
  itemId: number,
  statuses: Array<"ready" | "active" | "blocked" | "review" | "done">,
  offsetMinutes: number,
): void {
  const draft = getItem(db, itemId)?.stage === "draft";
  const path: Array<"ready" | "active" | "blocked" | "review" | "done"> =
    draft && statuses[0] !== "ready" ? ["ready", ...statuses] : [...statuses];
  for (const [index, status] of path.entries()) {
    transition(db, {
      itemId,
      to: status,
      actor: status === "ready" ? "user" : "system",
      reason: `Companion fidelity fixture: ${status}`,
      now: new Date(Date.parse(SEEDED_AT) + (offsetMinutes + index) * 60_000),
    });
  }
}

function seedPopulated(
  db: ReturnType<typeof openDb>,
  dataDir: string,
  scenario: "populated" | "no-results",
): CompanionFidelityManifest {
  const workdir = join(dataDir, "fixture-workdir");
  mkdirSync(workdir, { recursive: true });
  writeFileSync(
    join(workdir, "acceptance-report.md"),
    "# Companion fidelity acceptance\n\nDeterministic downloadable evidence.\n",
  );
  writeFileSync(join(workdir, "missing-export.txt"), "This blob is intentionally unavailable.\n");

  const now = () => new Date("2026-07-25T07:44:12.000Z");
  const coordinator = createCoordinator({ db, now });
  setAutoIncrement(db, "items", 37);
  const blockedChild = coordinator.createRootItem({
    title: "迁移 daemon 到常开机器",
    brief: "child 卡在权限，等你介入。",
    createdBy: "lead",
    workdir,
    priority: "low",
    project: "常开机器迁移",
    runtime: "pi",
  });
  setAutoIncrement(db, "items", 40);
  const secondary = coordinator.createRootItem({
    title: "M9 launchd 真机验收",
    brief: "在真机上完成 launchd 常驻验收。",
    createdBy: "lead",
    priority: "normal",
    project: "常开机器迁移",
    runtime: "pi",
  });
  const primary = coordinator.createRootItem({
    title: "移动控制面协议缺口审计",
    brief: "核对完整控制面所需能力与当前 paired API。",
    createdBy: "lead",
    workdir,
    priority: "high",
    project: "移动控制面 GA",
    runtime: "pi",
  });
  const primaryItem = db.prepare("SELECT root_item_id, project_id, project FROM items WHERE id=?")
    .get(primary) as { root_item_id: number; project_id: number | null; project: string | null };
  const childArgs = {
    createdBy: "child" as const,
    workdir,
    parentItemId: primary,
    rootItemId: primaryItem.root_item_id,
    projectId: primaryItem.project_id ?? undefined,
    project: primaryItem.project ?? undefined,
  };
  const completedChild = createItem(db, {
    ...childArgs,
    title: "枚举控制面能力",
    brief: "对照 spec 列出完整控制面所需的 14 项能力，逐项定位来源。",
    priority: "normal",
  });
  const runningChild = createItem(db, {
    ...childArgs,
    title: "比对 paired API",
    brief: "将 14 项能力与当前 paired API 覆盖度比对，标出缺口。",
    priority: "high",
  });
  const validationChild = createItem(db, {
    ...childArgs,
    title: "验证鉴权边界",
    brief: "验证 chat/status 的鉴权边界可读性，需放开 approvals。",
    priority: "high",
  });
  const blockedItem = db.prepare("SELECT root_item_id, project_id, project FROM items WHERE id=?")
    .get(blockedChild) as { root_item_id: number; project_id: number | null; project: string | null };
  const secondaryItem = db.prepare("SELECT root_item_id, project_id, project FROM items WHERE id=?")
    .get(secondary) as { root_item_id: number; project_id: number | null; project: string | null };
  setAutoIncrement(db, "items", 54);
  const tertiary = coordinator.createRootItem({
    title: "周报自动化汇总",
    brief: "持续汇总本周执行进展。",
    createdBy: "system",
    workdir,
    priority: "normal",
    project: "周报自动化",
    runtime: "pi",
    purpose: "integration",
  });
  const secondaryChildArgs = {
    brief: "Companion fidelity review child task",
    createdBy: "child" as const,
    parentItemId: secondary,
    rootItemId: secondaryItem.root_item_id,
    runtime: "pi" as const,
  };
  const launchdPackageChild = createItem(db, {
    ...secondaryChildArgs,
    title: "打包 launchd plist",
  });
  const launchdSmokeChild = createItem(db, {
    ...secondaryChildArgs,
    title: "真机安装冒烟",
  });
  const blockedChildArgs = {
    brief: "Companion fidelity blocked child task",
    createdBy: "child" as const,
    workdir,
    parentItemId: blockedChild,
    rootItemId: blockedItem.root_item_id,
    runtime: "pi" as const,
  };
  const environmentProbeChild = createItem(db, {
    ...blockedChildArgs,
    title: "探测目标机环境",
  });
  const launchdInstallChild = createItem(db, {
    ...blockedChildArgs,
    title: "安装 launchd 服务",
  });

  advanceItem(db, primary, ["active"], 1);
  advanceItem(db, completedChild, ["active", "review", "done"], 3);
  advanceItem(db, runningChild, ["active", "review", "done"], 7);
  advanceItem(db, validationChild, ["active"], 11);
  advanceItem(db, blockedChild, ["active", "blocked"], 13);
  // #41 / #48 停在 review，而 review 上只开得出 reviewer 的 Run（spec §6.5）。
  // 这两条工单的夹具 Run 是执行 Run，所以先停在 active，等下面把 Run 建出来再推到 review。
  advanceItem(db, secondary, ["active"], 16);
  advanceItem(db, tertiary, ["active"], 19);
  advanceItem(db, launchdPackageChild, ["active", "review", "done"], 21);
  advanceItem(db, launchdSmokeChild, ["active", "review", "done"], 25);
  advanceItem(db, environmentProbeChild, ["active", "review", "done"], 29);
  advanceItem(db, launchdInstallChild, ["active", "blocked"], 33);
  for (const [index, itemId] of [
    primary,
    completedChild,
    runningChild,
    validationChild,
    tertiary,
    launchdPackageChild,
    launchdSmokeChild,
    environmentProbeChild,
    launchdInstallChild,
  ].entries()) {
    setItemDates(db, itemId, index);
  }
  setItemDates(db, secondary, 3);
  setItemDates(db, blockedChild, 5);

  setAutoIncrement(db, "runs", 69);
  const blockedRunId = createRun(db, {
    itemId: blockedChild,
    runtime: "pi",
    model: "pi",
  });
  updateRun(db, blockedRunId, {
    state: "running",
    runtimeVersion: "fixture-1",
    externalSessionId: "sess_38a7c091",
    metadata: { fixture: true, scenario, blocked: true },
  });
  const secondaryRunId = createRun(db, {
    itemId: secondary,
    runtime: "pi",
    model: "pi",
  });
  updateRun(db, secondaryRunId, {
    state: "running",
    runtimeVersion: "fixture-1",
    externalSessionId: "sess_71b0e4d2",
    metadata: { fixture: true, scenario },
  });
  setAutoIncrement(db, "runs", 72);
  const runId = createRun(db, {
    itemId: primary,
    runtime: "pi",
    model: "pi",
  });
  updateRun(db, runId, {
    state: "running",
    runtimeVersion: "fixture-1",
    externalSessionId: "sess_9f42a1c7",
    metadata: { fixture: true, scenario },
  });
  const tertiaryRunId = createRun(db, {
    itemId: tertiary,
    runtime: "pi",
    model: "pi",
  });
  updateRun(db, tertiaryRunId, {
    state: "running",
    runtimeVersion: "fixture-1",
    externalSessionId: "sess_55a91f28",
    metadata: { fixture: true, scenario },
  });
  const validationRunId = createRun(db, {
    itemId: validationChild,
    runtime: "pi",
    model: "pi",
  });
  updateRun(db, validationRunId, {
    state: "running",
    runtimeVersion: "fixture-1",
    externalSessionId: "sess_45c3f19a",
    metadata: { fixture: true, scenario, child: true },
  });
  // Run 已建，现在才把两条工单推到 review（承接上面 advanceItem 里被拆开的那一步）。
  advanceItem(db, secondary, ["review"], 18);
  advanceItem(db, tertiary, ["review"], 21);
  db.prepare(
    `UPDATE runs SET started_at=?, session_id=?, pid=? WHERE id=?`,
  ).run("2026-07-25T07:38:00.000Z", "sess_9f42a1c7", 42420, runId);
  db.prepare("UPDATE runs SET started_at=?, session_id=?, pid=? WHERE id=?")
    .run("2026-07-25T07:40:00.000Z", "sess_38a7c091", 42417, blockedRunId);
  db.prepare("UPDATE runs SET started_at=?, ended_at=NULL, session_id=?, pid=? WHERE id=?")
    .run("2026-07-25T07:32:00.000Z", "sess_71b0e4d2", 42418, secondaryRunId);
  db.prepare("UPDATE runs SET started_at=?, session_id=?, pid=? WHERE id=?")
    .run("2026-07-25T07:40:00.000Z", "sess_55a91f28", 42455, tertiaryRunId);
  db.prepare("UPDATE runs SET started_at=?, session_id=?, pid=? WHERE id=?")
    .run("2026-07-25T07:42:00.000Z", "sess_45c3f19a", 42445, validationRunId);
  db.prepare(
    `UPDATE items SET first_run_at=?, total_tokens=?, total_cost_usd=? WHERE id=?`,
  ).run("2026-07-25T07:38:00.000Z", 18420, 0.42, primary);
  db.prepare("UPDATE items SET first_run_at=? WHERE id=?")
    .run("2026-07-25T07:40:00.000Z", tertiary);
  db.prepare("UPDATE items SET first_run_at=? WHERE id=?")
    .run("2026-07-25T07:42:00.000Z", validationChild);

  const turnId = "companion-fidelity-turn";
  createTurn(db, {
    id: turnId,
    originKind: "companion",
    itemId: primary,
    userText: "把移动控制面拆成能落地的计划，让 child 先做协议缺口审计。",
    now: new Date("2026-07-25T07:38:00.000Z"),
  });
  appendAssistantDelta(
    db,
    turnId,
    "已建好工单 #42，child 开工啦。我把后续都绑到 #42，但仍写在同一个 Lead 长会话里。",
    new Date("2026-07-25T07:38:00.000Z"),
  );
  completeTurn(db, turnId, new Date("2026-07-25T07:38:00.000Z"));
  upsertItemExecutionCard(db, {
    turnId,
    itemId: primary,
    operation: {
      id: "create-item",
      name: "create_ticket",
      state: "completed",
      label: "create_ticket",
      detail: `已创建工单 #${primary}`,
    },
    now: new Date("2026-07-25T07:38:10.000Z"),
  });
  upsertItemExecutionCard(db, {
    turnId,
    itemId: primary,
    operation: {
      id: "spawn-child",
      name: "spawn_child",
      state: "running",
      label: "spawn_child",
      detail: "child #73 正在执行",
    },
    now: new Date("2026-07-25T07:38:20.000Z"),
  });
  const followupTurnId = "companion-fidelity-followup";
  createTurn(db, {
    id: followupTurnId,
    originKind: "companion",
    itemId: primary,
    userText: "",
    now: new Date("2026-07-25T07:41:00.000Z"),
  });
  appendAssistantDelta(
    db,
    followupTurnId,
    "你可以在这儿继续调方向，也能打开右侧线程，只围绕 #42 补上下文。",
    new Date("2026-07-25T07:41:00.000Z"),
  );
  completeTurn(db, followupTurnId, new Date("2026-07-25T07:41:00.000Z"));

  const stagedArtifacts = [
    stageArtifact(db, {
      dataDir,
      itemId: primary,
      runId,
      ref: "acceptance-report",
      name: "protocol-gap-report.md",
      kind: "report",
      mediaType: "text/markdown",
      description: "Deterministic acceptance evidence",
      relativePath: "acceptance-report.md",
    }),
    stageArtifact(db, {
      dataDir,
      itemId: primary,
      runId,
      ref: "legacy-reference",
      name: "capability-matrix.csv",
      kind: "reference",
      mediaType: "text/plain",
      description: "Metadata-only legacy artifact",
      relativePath: null,
    }),
    stageArtifact(db, {
      dataDir,
      itemId: primary,
      runId,
      ref: "missing-export",
      name: "paired-server.diff",
      kind: "log",
      mediaType: "text/plain",
      description: "Unavailable artifact fixture",
      relativePath: "missing-export.txt",
    }),
  ];
  coordinator.submitCheckpoint({
    itemId: primary,
    runId,
    kind: "progress",
    stage: "implementation",
    title: "核心场景已接通",
    summary: "共享视图、确定性状态与下载资源已进入验收阶段。",
    keyFacts: [
      { label: "能力覆盖", value: "11/14" },
      { label: "发现缺口", value: "3" },
    ],
    progress: { current: 8, total: 13, label: "验收步骤" },
    proofItems: [
      { id: "capability-check", label: "枚举控制面所需能力", state: "passed", evidence: "对照 spec 列出 14 项，全部定位到来源" },
      { id: "paired-api-check", label: "比对当前 paired API 覆盖", state: "passed", evidence: "11/14 已覆盖，命中 3 处缺口" },
      { id: "security-boundary-check", label: "鉴权边界可读性验证", state: "pending", evidence: "chat/status 需放开 approvals 才能读，待你批准" },
    ],
    artifactRefs: stagedArtifacts.map((artifact) => artifact.ref),
    stagedArtifacts,
    idempotencyKey: "companion-fidelity:primary-progress",
  });
  coordinator.submitCheckpoint({
    itemId: validationChild,
    runId: validationRunId,
    kind: "progress",
    stage: "authorization-validation",
    title: "鉴权边界验证进行中",
    summary: "正在验证 chat/status 的 approvals 读取边界。",
    progress: { current: 11, total: 20, label: "验证进度" },
    proofItems: [],
    idempotencyKey: "companion-fidelity:validation-child-progress",
  });
  const artifacts = listArtifacts(db, primary);
  const artifactsByRef = new Map(artifacts.map((artifact) => [artifact.ref, artifact]));
  const unavailable = artifactsByRef.get("missing-export")!;
  db.prepare(
    "UPDATE artifacts SET availability='unavailable', storage_key=NULL WHERE id=?",
  ).run(unavailable.id);

  const intervention = coordinator.requestApproval({
    itemId: blockedChild,
    runId: blockedRunId,
    requestedBy: "child",
    tool: "install_launchd_service",
    action: "授权安装 launchd 服务并继续",
    payload: { fixture: true },
    checkpoint: {
      title: "迁移 daemon 到常开机器",
      summary: "child 跑到一半卡住了：目标机器要 sudo 授权才能安装 launchd 服务，它没有权限，先停下来等你。",
      keyFacts: [
        { label: "stderr", value: "Operation not permitted: /Library/LaunchDaemons" },
      ],
      nextStep: "授权后继续安装并验证常驻运行。",
    },
  });
  if (intervention.status !== "pending") throw new Error("fixture approval unexpectedly auto-approved");
  db.prepare("UPDATE approvals SET created_at=?, expires_at=? WHERE id=?")
    .run("2026-07-25T07:43:00.000Z", "2026-07-25T08:43:00.000Z", intervention.approvalId);
  db.prepare("UPDATE checkpoints SET created_at=? WHERE id=?")
    .run("2026-07-25T07:43:00.000Z", intervention.checkpoint.id);
  db.prepare("UPDATE conversation_cards SET created_at=?, updated_at=? WHERE checkpoint_id=?")
    .run("2026-07-25T07:43:00.000Z", "2026-07-25T07:43:00.000Z", intervention.checkpoint.id);
  setItemDates(db, blockedChild, 5);

  coordinator.submitCheckpoint({
    itemId: tertiary,
    runId: tertiaryRunId,
    kind: "progress",
    stage: "weekly-summary",
    title: "周报汇总进行中",
    summary: "已完成 28% 的本周执行摘要。",
    progress: { current: 7, total: 25, label: "汇总进度" },
    proofItems: [],
    idempotencyKey: "companion-fidelity:tertiary-progress",
  });

  const agendaSeededAt = new Date("2026-07-26T00:00:00.000Z");
  const agendaSchedules = [
    {
      title: "移动控制面协议评审",
      brief: "与 #42 关联",
      cron: "0 10 27 7 *",
      project: "移动控制面 GA",
    },
    {
      title: "M9 真机验收窗口",
      brief: "#41 待验收",
      cron: "0 14 28 7 *",
      project: "常开机器迁移",
    },
    {
      title: "daemon 迁移复盘",
      brief: "#38 解阻后",
      cron: "0 11 30 7 *",
      project: "常开机器迁移",
    },
    {
      title: "周报交付",
      brief: "#55 · 自动汇总",
      cron: "0 16 31 7 *",
      project: "周报自动化",
    },
  ];
  for (const schedule of agendaSchedules) {
    // 例行条目现在是 cron trigger；不派 child 的那一类产出 reminder 而不是永不执行的工单。
    createCronTrigger(db, {
      label: schedule.title, cronExpr: schedule.cron, createdBy: "user",
      action: {
        type: "create_item",
        payload: {
          kind: "reminder", title: schedule.title,
          body: schedule.brief, brief: schedule.brief, project: schedule.project,
        },
      },
    }, agendaSeededAt);
  }

  const eventStore = createRuntimeEventStore(db, { dataDir });
  const toolNames = [
    "read_file", "search_protocol", "inspect_gateway", "compare_capabilities", "read_auth",
    "trace_scope", "check_approvals", "run_tests", "write_report",
  ];
  const events: RuntimeEvent[] = [
    { type: "run.started", runId, seq: 1, occurredAt: "2026-07-25T07:38:00.000Z", runtime: "pi", model: "pi" },
    { type: "session.updated", runId, seq: 2, occurredAt: "2026-07-25T07:38:01.000Z", externalSessionId: "sess_9f42a1c7", runtimeVersion: "fixture-1" },
    ...toolNames.flatMap((name, index): RuntimeEvent[] => {
      const seq = 3 + index * 2;
      const occurredAt = new Date(Date.parse("2026-07-25T07:38:10.000Z") + index * 30_000).toISOString();
      const callId = `fidelity-tool-${index + 1}`;
      return [
        { type: "tool.started", runId, seq, occurredAt, callId, name, args: { fixture: true } },
        { type: "tool.completed", runId, seq: seq + 1, occurredAt, callId, name, result: { ok: true } },
      ];
    }),
    { type: "message.completed", runId, seq: 21, occurredAt: "2026-07-25T07:42:30.000Z", messageId: "fixture-summary", role: "assistant", text: "已定位三个真实协议缺口。" },
  ];
  for (const event of events) eventStore.persist(event);

  const downloadableId = artifactsByRef.get("acceptance-report")!.id;
  const metadataOnlyId = artifactsByRef.get("legacy-reference")!.id;
  const expectedSelectors = [
    ...BASE_SELECTORS,
    ...ITEM_SELECTORS,
    `artifact-download-${downloadableId}`,
    `artifact-cancel-${downloadableId}`,
    `artifact-retry-${downloadableId}`,
  ];
  return {
    version: 1,
    fixture: "companion-fidelity",
    scenario,
    seededAt: SEEDED_AT,
    dataDir,
    dbPath: join(dataDir, "plc.db"),
    itemIds: { primary, completedChild, runningChild, validationChild, blockedChild, secondary, tertiary },
    runIds: { primary: runId },
    artifactIds: {
      downloadable: downloadableId,
      metadataOnly: metadataOnlyId,
      unavailable: unavailable.id,
    },
    interventionIds: { approval: intervention.approvalId },
    expectedSelectors,
    expectedWorkspaceState: {
      rail: scenario === "no-results" ? "no_results" : "populated",
      destination: "items",
      filter: scenario === "no-results" ? "todo" : "all",
      searchQuery: scenario === "no-results" ? "fixture-query-with-no-matches" : "",
      selectedItemId: primary,
    },
  };
}

function seedAllCompleted(
  db: ReturnType<typeof openDb>,
  dataDir: string,
): CompanionFidelityManifest {
  const ids = [
    createItem(db, { title: "原型结构验收完成", brief: "completed fixture", createdBy: "lead", priority: "high" }),
    createItem(db, { title: "跨端导航验收完成", brief: "completed fixture", createdBy: "lead" }),
    createItem(db, { title: "下载状态验收完成", brief: "completed fixture", createdBy: "lead", priority: "low" }),
  ];
  for (const [index, itemId] of ids.entries()) {
    advanceItem(db, itemId, ["active", "review", "done"], index * 5);
    setItemDates(db, itemId, index);
  }
  return {
    version: 1,
    fixture: "companion-fidelity",
    scenario: "all-completed",
    seededAt: SEEDED_AT,
    dataDir,
    dbPath: join(dataDir, "plc.db"),
    ...emptyIds(),
    itemIds: {
      primary: ids[0]!,
      completedChild: null,
      runningChild: null,
      validationChild: null,
      blockedChild: null,
      secondary: ids[1]!,
      tertiary: ids[2]!,
    },
    expectedSelectors: BASE_SELECTORS,
    expectedWorkspaceState: {
      rail: "all_completed",
      destination: "items",
      filter: "all",
      searchQuery: "",
      selectedItemId: null,
    },
  };
}

export function seedCompanionFidelity(input: {
  dataDir: string;
  scenario: FidelityScenario;
}): CompanionFidelityManifest {
  if (!FIDELITY_SCENARIOS.includes(input.scenario)) {
    throw new Error(`unknown fidelity scenario '${input.scenario}'`);
  }
  const dataDir = resolve(input.dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const fixturePath = join(dataDir, FIXTURE_FILE);
  try {
    const existing = JSON.parse(readFileSync(fixturePath, "utf8")) as CompanionFidelityManifest;
    if (existing.fixture !== "companion-fidelity" || existing.version !== 1) {
      throw new Error("existing fidelity manifest is invalid");
    }
    if (existing.scenario !== input.scenario) {
      throw new Error(`data directory already belongs to scenario '${existing.scenario}'`);
    }
    return existing;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const dbPath = join(dataDir, "plc.db");
  const db = openDb(dbPath);
  let manifest: CompanionFidelityManifest;
  try {
    if (input.scenario === "populated" || input.scenario === "no-results") {
      manifest = seedPopulated(db, dataDir, input.scenario);
    } else if (input.scenario === "all-completed") {
      manifest = seedAllCompleted(db, dataDir);
    } else {
      manifest = {
        version: 1,
        fixture: "companion-fidelity",
        scenario: "first-use",
        seededAt: SEEDED_AT,
        dataDir,
        dbPath,
        ...emptyIds(),
        expectedSelectors: BASE_SELECTORS,
        expectedWorkspaceState: {
          rail: "first_use",
          destination: "items",
          filter: "all",
          searchQuery: "",
          selectedItemId: null,
        },
      };
    }
  } finally {
    db.close();
  }
  atomicWriteJson(fixturePath, manifest);
  return manifest;
}

function parseCliArgs(argv: string[]): { dataDir: string; scenario: FidelityScenario } {
  let dataDir = "";
  let scenario = "";
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--data-dir") dataDir = argv[++index] ?? "";
    else if (argv[index] === "--scenario") scenario = argv[++index] ?? "";
    else throw new Error(`unknown argument '${argv[index]}'`);
  }
  if (!dataDir) throw new Error("--data-dir is required");
  if (!FIDELITY_SCENARIOS.includes(scenario as FidelityScenario)) {
    throw new Error(`--scenario must be one of ${FIDELITY_SCENARIOS.join(", ")}`);
  }
  return { dataDir, scenario: scenario as FidelityScenario };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(seedCompanionFidelity(parseCliArgs(process.argv.slice(2)))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
