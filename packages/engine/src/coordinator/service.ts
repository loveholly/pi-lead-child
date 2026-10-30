import type { Db } from "@pi-lead-child/store";
import { runUpdatedEvent } from "@pi-lead-child/store";
import { resolveProjectForWorkdir } from "./project-resolver.js";
import { canonicalProjectId, createProject, findProject, getProject } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { addAcceptanceCriteria, listAcceptanceCriteria, normalizeCriterionTexts } from "@pi-lead-child/store";
import { getItem, updateOrchestrationState } from "@pi-lead-child/store";
import { getRun } from "@pi-lead-child/store";
import {
  dependencyWouldCycle, listChildren, listDependencies, listDescendants,
  type ItemDependency,
} from "@pi-lead-child/store";
import type { RunPurpose, RuntimeId, Item, ItemPriority, VerificationPolicy } from "@pi-lead-child/core";
import {
  createCheckpointDomainService,
  type CheckpointDomainService,
} from "./checkpoints.js";
import {
  createInterventionDomainService,
  type InterventionDomainService,
} from "./interventions.js";
import {
  createWorkbenchDomainService,
  type WorkbenchDomainService,
} from "./workbench.js";

export interface PlanningContext {
  itemId: number;
  runId: number;
  revision?: number;
}

export interface SubitemInput {
  title: string;
  brief: string;
  priority?: ItemPriority;
  workdir?: string;
  workflowKind?: "generic" | "coding";
  runtime?: RuntimeId;
  model?: string;
  purpose?: RunPurpose;
  required?: boolean;
  // 子工单的验收标准（工单 05，spec 5.1：执行 agent 拆出的子工单由执行 agent 写）。规则在 store 的 acceptance-criteria.ts。
  acceptanceCriteria?: unknown;
}

export interface Coordinator extends CheckpointDomainService, InterventionDomainService, WorkbenchDomainService {
  createRootItem(input: {
    title: string; brief: string; createdBy: "user" | "lead" | "system";
    workdir?: string; workflowKind?: "generic" | "coding"; priority?: ItemPriority; project?: string; projectId?: number;
    runtime?: RuntimeId; model?: string; purpose?: RunPurpose;
    // 谁核查。不给时是 Lead 静态核对（lead_static）。
    verificationPolicy?: VerificationPolicy;
    // 用户要求"先别动，等我确认"时为 true —— 建成 draft。缺省 false：常规路径建完即跑。
    hold?: boolean;
  }): number;
  beginPlanning(context: Omit<PlanningContext, "revision">): number;
  reopenPlanning(context: Omit<PlanningContext, "revision">, options?: { retainChildIds?: number[] }): number;
  createSubitem(context: PlanningContext, input: SubitemInput): number;
  createWorkPlan(
    context: PlanningContext,
    plan: { items: Array<SubitemInput & { key: string; dependsOn?: string[] }> },
  ): { byKey: Record<string, number> };
  addDependency(context: PlanningContext, itemId: number, dependsOnItemId: number): void;
  finishPlanning(context: PlanningContext): number;
  recordSubitemCompleted(input: {
    parentItemId: number;
    childItemId: number;
    runId: number;
  }): void;
  listChildren(itemId: number): Item[];
  listDescendants(itemId: number): Item[];
  listDependencies(itemId: number): ItemDependency[];
}

export function createCoordinator(args: { db: Db; now?: () => Date }): Coordinator {
  const { db } = args;
  const checkpoints = createCheckpointDomainService(args);
  const interventions = createInterventionDomainService({
    db,
    checkpoints,
    now: args.now,
  });
  const workbench = createWorkbenchDomainService({
    db,
    interventions,
    now: args.now,
  });
  const assertOwner = (context: Omit<PlanningContext, "revision">) => {
    const item = getItem(db, context.itemId);
    if (!item) throw new Error(`item #${context.itemId} not found`);
    const run = getRun(db, context.runId);
    if (!run || run.item_id !== item.id || !["starting", "running"].includes(run.state)) {
      throw new Error(`run #${context.runId} does not actively own item #${item.id}`);
    }
    return { item, run };
  };

  const openRevision = (context: PlanningContext) => {
    const { item, run } = assertOwner(context);
    const revision = context.revision ?? item.active_plan_revision;
    if (!revision) throw new Error(`item #${item.id} has no open planning revision`);
    const row = db.prepare(
      "SELECT state FROM item_plan_revisions WHERE parent_item_id=? AND revision=?",
    ).get(item.id, revision) as { state: string } | undefined;
    if (!row) throw new Error(`planning revision ${revision} not found for item #${item.id}`);
    if (row.state !== "open") throw new Error(`planning revision ${revision} is ${row.state}, not open`);
    if (row.state === "open" && run.id !== context.runId) throw new Error("planning owner changed");
    return { item, run, revision };
  };

  const depthOf = (item: Item): number => {
    let depth = 0;
    let current = item;
    while (current.parent_item_id !== null) {
      depth++;
      const parent = getItem(db, current.parent_item_id);
      if (!parent) throw new Error(`broken parent chain at item #${current.id}`);
      current = parent;
    }
    return depth;
  };

  const recordPlanSealed = (parent: Item, revision: number) => checkpoints.recordSystemCheckpoint({
    itemId: parent.id,
    kind: "milestone",
    title: "Planning revision sealed",
    summary: `Planning revision ${revision} for item #${parent.id} was sealed for dispatch.`,
    idempotencyKey: `plan-sealed:${parent.id}:${revision}`,
  });

  const createPlannedSubitem = (
    context: PlanningContext,
    input: SubitemInput,
    itemKey?: string,
  ): { id: number; replayed: boolean } => {
    const { item: parent, revision } = openRevision(context);
    if (itemKey !== undefined && !itemKey.trim()) throw new Error("plan item key cannot be empty");
    const criteria = input.acceptanceCriteria === undefined ? [] : normalizeCriterionTexts(input.acceptanceCriteria);
      const workdir = input.workdir ?? parent.workdir ?? undefined;
    const workflowKind = input.workflowKind ?? parent.workflow_kind;
    if (input.workdir && parent.workdir) {
      const base = parent.workdir.endsWith("/") ? parent.workdir : `${parent.workdir}/`;
      if (input.workdir !== parent.workdir && !input.workdir.startsWith(base)) {
        throw new Error("subitem workdir escapes parent scope");
      }
    }

    if (itemKey !== undefined) {
      const existing = db.prepare(
        `SELECT t.*, m.required FROM item_plan_memberships m
         JOIN items t ON t.id=m.child_item_id
         WHERE m.parent_item_id=? AND m.revision=? AND m.item_key=?`,
      ).get(parent.id, revision, itemKey) as (Item & { required: number }) | undefined;
      if (existing) {
        const matches = existing.title === input.title &&
          existing.brief === input.brief &&
          existing.priority === (input.priority ?? parent.priority) &&
          existing.workdir === (workdir ?? null) &&
          existing.workflow_kind === workflowKind &&
          existing.requested_runtime === (input.runtime ?? parent.requested_runtime ?? null) &&
          existing.requested_model === (input.model ?? parent.requested_model ?? null) &&
          existing.purpose === (input.purpose ?? "execution") &&
          existing.required === (input.required === false ? 0 : 1) &&
          JSON.stringify(listAcceptanceCriteria(db, existing.id).map((row) => row.text)) === JSON.stringify(criteria);
        if (!matches) throw new Error(`plan key '${itemKey}' conflict: child specification changed`);
        return { id: existing.id, replayed: true };
      }
    }

    // root_item_id 为空即"parent 自己就是树根"——预算与限流权威落在它身上。
    const root = getItem(db, parent.root_item_id ?? parent.id) ?? parent;
    const childDepth = depthOf(parent) + 1;
    const maxDepth = root.max_depth ?? Number(process.env.PLC_MAX_TICKET_DEPTH ?? 3);
    if (childDepth > maxDepth) throw new Error(`max depth ${maxDepth} exceeded`);
    const childCount = (db.prepare("SELECT COUNT(*) AS n FROM items WHERE parent_item_id=?")
      .get(parent.id) as { n: number }).n;
    const maxChildren = root.max_children ?? Number(process.env.PLC_MAX_TICKET_CHILDREN ?? 12);
    if (childCount >= maxChildren) throw new Error(`max children ${maxChildren} exceeded`);

    return db.transaction(() => {
      const id = createItem(db, {
        title: input.title, brief: input.brief, createdBy: "child", workdir,
        workflowKind,
        priority: input.priority ?? parent.priority, project: parent.project ?? undefined,
        projectId: parent.project_id ?? undefined, parentItemId: parent.id,
        rootItemId: root.id, createdByRunId: context.runId,
        runtime: input.runtime ?? parent.requested_runtime ?? undefined,
        model: input.model ?? parent.requested_model ?? undefined,
        purpose: input.purpose ?? "execution", verificationPolicy: "independent_reviewer",
      });
      if (criteria.length) addAcceptanceCriteria(db, { itemId: id, texts: criteria, by: "child", runId: context.runId });
      db.prepare(
        `INSERT INTO item_plan_memberships
         (parent_item_id, revision, child_item_id, item_key, required) VALUES (?, ?, ?, ?, ?)`,
      ).run(parent.id, revision, id, itemKey ?? null, input.required === false ? 0 : 1);
      checkpoints.recordSystemCheckpoint({
        itemId: parent.id,
        kind: "delegation",
        title: "Child item created",
        summary: `Created child item #${id}: ${input.title}`,
        relatedItemIds: [id],
        nextStep: `Wait for child item #${id} to complete.`,
        idempotencyKey: `subitem-created:${parent.id}:${id}`,
        precedingEvents: [{
          // 线上信封：事件名、scope 与 payload 键都由 protocol 冻结，不随内部 item 改名走。
          type: "ticket.created",
          requiredScope: "tickets:view",
          itemId: id,
          payload: { ticketId: id, parentTicketId: parent.id, snapshotRequired: true },
        }],
      });
      return { id, replayed: false };
    })();
  };

  const coordinator: Coordinator = {
    ...checkpoints,
    ...interventions,
    ...workbench,

    createRootItem(input): number {
      let projectId: number | undefined;
      let projectName: string | undefined;
      if (input.projectId !== undefined) {
        projectId = canonicalProjectId(db, input.projectId);
        projectName = getProject(db, projectId)?.name;
      } else if (input.project) {
        const project = findProject(db, input.project);
        projectId = project?.id ?? createProject(db, {
          name: input.project, createdBy: input.createdBy,
        });
        projectName = getProject(db, projectId)?.name;
      } else if (input.workdir) {
        const project = resolveProjectForWorkdir(db, input.workdir, {
          createdBy: `system:repo-resolution:${input.createdBy}`,
        });
        projectId = project?.id;
        projectName = project?.name;
      }
      return createItem(db, {
        title: input.title, brief: input.brief, createdBy: input.createdBy,
        workdir: input.workdir, priority: input.priority, project: projectName,
        projectId, runtime: input.runtime, model: input.model,
        purpose: input.purpose, verificationPolicy: input.verificationPolicy, hold: input.hold,
        workflowKind: input.workflowKind,
      });
    },

    beginPlanning(context): number {
      const { item } = assertOwner(context);
      const existing = item.active_plan_revision
        ? db.prepare(
            "SELECT revision FROM item_plan_revisions WHERE parent_item_id=? AND revision=? AND state='open'",
          ).get(item.id, item.active_plan_revision) as { revision: number } | undefined
        : undefined;
      if (existing) return existing.revision;
      const next = (db.prepare(
        "SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM item_plan_revisions WHERE parent_item_id=?",
      ).get(item.id) as { revision: number }).revision;
      db.transaction(() => {
        db.prepare(
          `INSERT INTO item_plan_revisions
           (parent_item_id, revision, state, created_by_run_id) VALUES (?, ?, 'open', ?)`,
        ).run(item.id, next, context.runId);
        db.prepare(
          `UPDATE items SET active_plan_revision=?, plan_state='planning',
           updated_at=datetime('now') WHERE id=?`,
        ).run(next, item.id);
      })();
      return next;
    },

    reopenPlanning(context, options): number {
      const { item } = assertOwner(context);
      if (item.active_plan_revision) {
        const active = db.prepare(
          `SELECT COUNT(*) AS n FROM dispatch_requests
           WHERE plan_owner_item_id=? AND plan_revision=? AND state IN ('claimed','started')`,
        ).get(item.id, item.active_plan_revision) as { n: number };
        if (active.n) throw new Error("cannot replan while prior revision has active claims");
      }
      const next = (db.prepare(
        "SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM item_plan_revisions WHERE parent_item_id=?",
      ).get(item.id) as { revision: number }).revision;
      db.transaction(() => {
        db.prepare(
          "UPDATE item_plan_revisions SET state='superseded' WHERE parent_item_id=? AND state='sealed'",
        ).run(item.id);
        db.prepare(
          `INSERT INTO item_plan_revisions
           (parent_item_id, revision, state, created_by_run_id) VALUES (?, ?, 'open', ?)`,
        ).run(item.id, next, context.runId);
        for (const childId of options?.retainChildIds ?? []) {
          const child = getItem(db, childId);
          if (!child || child.parent_item_id !== item.id) {
            throw new Error(`item #${childId} is not a child of #${item.id}`);
          }
          db.prepare(
            `INSERT INTO item_plan_memberships
             (parent_item_id, revision, child_item_id, required) VALUES (?, ?, ?, 1)`,
          ).run(item.id, next, childId);
        }
        updateOrchestrationState(db, item.id, "planning", next);
      })();
      return next;
    },

    createSubitem(context, input): number {
      return createPlannedSubitem(context, input).id;
    },

    createWorkPlan(context, plan): { byKey: Record<string, number> } {
      return db.transaction(() => {
        const planContext = { ...context, revision: openRevision(context).revision };
        const byKey: Record<string, number> = {};
        const seen = new Set<string>();
        const replayed = new Set<string>();
        for (const item of plan.items) {
          if (seen.has(item.key)) throw new Error(`duplicate plan key: ${item.key}`);
          seen.add(item.key);
          const result = createPlannedSubitem(planContext, item, item.key);
          byKey[item.key] = result.id;
          if (result.replayed) replayed.add(item.key);
        }
        for (const item of plan.items) {
          const dependencyKeys = item.dependsOn ?? [];
          const desiredDependencyIds = dependencyKeys.map((dependency) => {
            if (!byKey[dependency]) throw new Error(`unknown dependency key: ${dependency}`);
            return byKey[dependency];
          }).sort((left, right) => left - right);
          if (replayed.has(item.key)) {
            const existingDependencyIds = (db.prepare(
              `SELECT depends_on_item_id FROM item_dependencies
               WHERE parent_item_id=? AND plan_revision=? AND item_id=?
               ORDER BY depends_on_item_id`,
            ).all(planContext.itemId, planContext.revision, byKey[item.key]) as Array<{
              depends_on_item_id: number;
            }>).map((row) => row.depends_on_item_id);
            if (JSON.stringify(existingDependencyIds) !== JSON.stringify(desiredDependencyIds)) {
              throw new Error(`plan key '${item.key}' conflict: dependencies changed`);
            }
            continue;
          }
          for (const dependencyId of desiredDependencyIds) {
            this.addDependency(planContext, byKey[item.key], dependencyId);
          }
        }
        return { byKey };
      }).immediate();
    },

    addDependency(context, itemId, dependsOnItemId): void {
      const { item: parent, revision } = openRevision(context);
      const memberships = db.prepare(
        `SELECT child_item_id FROM item_plan_memberships
         WHERE parent_item_id=? AND revision=? AND child_item_id IN (?, ?)`,
      ).all(parent.id, revision, itemId, dependsOnItemId) as Array<{ child_item_id: number }>;
      if (new Set(memberships.map((row) => row.child_item_id)).size !== 2) {
        throw new Error("dependencies must be siblings in the same parent revision");
      }
      if (dependencyWouldCycle(db, parent.id, revision, itemId, dependsOnItemId)) {
        throw new Error("dependency cycle detected");
      }
      db.prepare(
        `INSERT OR IGNORE INTO item_dependencies
         (parent_item_id, plan_revision, item_id, depends_on_item_id, created_by_run_id)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(parent.id, revision, itemId, dependsOnItemId, context.runId);
    },

    finishPlanning(context): number {
      const { item: parent } = assertOwner(context);
      const revision = context.revision ?? parent.active_plan_revision;
      if (!revision) throw new Error(`item #${parent.id} has no planning revision`);
      const current = db.prepare(
        `SELECT state FROM item_plan_revisions
         WHERE parent_item_id=? AND revision=?`,
      ).get(parent.id, revision) as { state: string } | undefined;
      if (!current) throw new Error(`planning revision ${revision} not found for item #${parent.id}`);
      if (current.state === "sealed") {
        recordPlanSealed(parent, revision);
        return revision;
      }
      if (current.state !== "open") {
        throw new Error(`planning revision ${revision} is ${current.state}, not open`);
      }
      db.transaction(() => {
        db.prepare(
          `UPDATE item_plan_revisions SET state='sealed', sealed_at=datetime('now')
           WHERE parent_item_id=? AND revision=?`,
        ).run(parent.id, revision);
        updateOrchestrationState(db, parent.id, "waiting", revision);
        const members = db.prepare(
          `SELECT t.* FROM item_plan_memberships m JOIN items t ON t.id=m.child_item_id
           WHERE m.parent_item_id=? AND m.revision=? AND m.required=1 ORDER BY t.id`,
        ).all(parent.id, revision) as Item[];
        for (const child of members) {
          if (["done", "cancelled"].includes(child.stage)) continue;
          // 幂等键写死在 item_plan_memberships.item_key 里，存量行认的是 :ticket:。
          // 跟着内部改名会让重规划对老行失去幂等，凭空造出重复的 child。
          const key = `plan:${parent.id}:${revision}:ticket:${child.id}:${child.purpose}:0`;
          db.prepare(
            `INSERT OR IGNORE INTO dispatch_requests
             (item_id, role, purpose, runtime, model, plan_owner_item_id, plan_revision,
              trigger, idempotency_key)
             VALUES (?, 'executor', ?, ?, ?, ?, ?, 'plan', ?)`,
          ).run(child.id, child.purpose, child.requested_runtime, child.requested_model,
            parent.id, revision, key);
        }
        recordPlanSealed(parent, revision);
      })();
      return revision;
    },

    recordSubitemCompleted(input): void {
      const parent = getItem(db, input.parentItemId);
      const child = getItem(db, input.childItemId);
      const run = getRun(db, input.runId);
      if (!parent) throw new Error(`parent item #${input.parentItemId} not found`);
      if (!child || child.parent_item_id !== parent.id) {
        throw new Error(`item #${input.childItemId} is not a child of #${parent.id}`);
      }
      if (!run || run.item_id !== child.id) {
        throw new Error(`run #${input.runId} does not belong to child item #${child.id}`);
      }
      if (run.role !== "executor" || run.state !== "finished") {
        throw new Error(`executor run #${run.id} must be settled before child completion`);
      }
      if (child.stage !== "done") {
        throw new Error(`child item #${child.id} must be done before completion is recorded`);
      }
      checkpoints.recordSystemCheckpoint({
        itemId: parent.id,
        kind: "milestone",
        title: "Child item completed",
        summary: `Child item #${child.id} completed in run #${run.id}.`,
        relatedItemIds: [child.id],
        idempotencyKey: `subitem-completed:${parent.id}:${child.id}:${run.id}`,
        precedingEvents: [runUpdatedEvent(child.id, run.id)],
      });
    },

    listChildren(itemId): Item[] { return listChildren(db, itemId); },
    listDescendants(itemId): Item[] { return listDescendants(db, itemId); },
    listDependencies(itemId): ItemDependency[] { return listDependencies(db, itemId); },
  };
  return coordinator;
}
