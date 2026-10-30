import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDispatcher } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { previewItemRestore, restoreItemTree } from "@pi-lead-child/engine";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun } from "@pi-lead-child/store";
import { listActivities } from "@pi-lead-child/store";
import { createProject, linkProjectRepository } from "@pi-lead-child/store";
import {
  canonicalDuplicateOf,
  duplicateSourcesFor,
  getTicketRelations,
  linkTickets,
  revokeTicketRelation,
  supersededBy,
} from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-relations-"), "plc.db"));
});

function task(title: string, options: {
  project?: string;
  projectId?: number;
  workdir?: string;
  parentItemId?: number;
  rootItemId?: number;
  purpose?: "execution" | "review" | "integration" | "learning";
} = {}): number {
  return createItem(db, {
    title,
    brief: "b",
    createdBy: "lead",
    project: options.project,
    projectId: options.projectId,
    workdir: options.workdir,
    parentItemId: options.parentItemId,
    rootItemId: options.rootItemId,
    purpose: options.purpose,
  });
}

describe("ticket relation ledger", () => {
  it("rejects self links, missing tickets, cancelled tickets, and parent copies", () => {
    const a = task("A");
    const b = task("B");
    transition(db, { itemId: b, to: "cancelled", actor: "lead", reason: "obsolete" });

    expect(() => linkTickets(db, {
      sourceTicketId: a, targetTicketId: a, relationType: "relates_to", reason: "same", actor: "lead",
    })).toThrow(/itself/);
    expect(() => linkTickets(db, {
      sourceTicketId: a, targetTicketId: 999, relationType: "relates_to", reason: "missing", actor: "lead",
    })).toThrow(/target item #999 not found/);
    expect(() => linkTickets(db, {
      sourceTicketId: a, targetTicketId: b, relationType: "relates_to", reason: "cancelled", actor: "lead",
    })).toThrow(/target item #\d+ is cancelled/);
    expect(() => linkTickets(db, {
      sourceTicketId: a, targetTicketId: b, relationType: "parent_of", reason: "tree", actor: "lead",
    })).toThrow(/existing task tree/);
  });

  it("deduplicates repeated links, revokes without deleting, and allows rebuilding after revoke", () => {
    const a = task("A");
    const b = task("B");
    const first = linkTickets(db, {
      sourceTicketId: a, targetTicketId: b, relationType: "depends_on", reason: "wait for B", actor: "lead",
    });
    const replay = linkTickets(db, {
      sourceTicketId: a, targetTicketId: b, relationType: "depends_on", reason: "wait for B", actor: "lead",
    });
    expect(replay.status).toBe("existing");
    expect(replay.relation.id).toBe(first.relation.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM ticket_relations").get() as { n: number }).n).toBe(1);

    const revoked = revokeTicketRelation(db, {
      relationId: first.relation.id, reason: "B no longer gates A", actor: "lead",
    });
    expect(revoked.status).toBe("revoked");
    expect(revoked.relation.revoked_at).toEqual(expect.any(String));
    const rebuilt = linkTickets(db, {
      sourceTicketId: a, targetTicketId: b, relationType: "depends_on", reason: "gate restored", actor: "lead",
    });
    expect(rebuilt.status).toBe("created");
    expect(rebuilt.relation.id).not.toBe(first.relation.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM ticket_relations").get() as { n: number }).n).toBe(2);
  });

  it("detects depends_on cycles", () => {
    const a = task("A");
    const b = task("B");
    const c = task("C");
    linkTickets(db, {
      sourceTicketId: a, targetTicketId: b, relationType: "depends_on", reason: "A waits B", actor: "lead",
    });
    linkTickets(db, {
      sourceTicketId: b, targetTicketId: c, relationType: "depends_on", reason: "B waits C", actor: "lead",
    });
    expect(() => linkTickets(db, {
      sourceTicketId: c, targetTicketId: a, relationType: "depends_on", reason: "cycle", actor: "lead",
    })).toThrow(/cycle/);
  });

  it("requires a reason and returns visible cross-project and workdir risks", () => {
    const a = task("A", { project: "alpha", workdir: "/repo/alpha" });
    const b = task("B", { project: "beta", workdir: "/repo/beta" });
    expect(() => linkTickets(db, {
      sourceTicketId: a, targetTicketId: b, relationType: "depends_on", reason: " ", actor: "lead",
    })).toThrow(/reason is required/);
    const result = linkTickets(db, {
      sourceTicketId: a,
      targetTicketId: b,
      relationType: "depends_on",
      reason: "cross-project release dependency accepted by lead",
      actor: "lead",
    });
    expect(result.risks.join("\n")).toMatch(/cross_project/);
    expect(result.risks.join("\n")).toMatch(/workdir_scope_mismatch/);
    expect(result.schedulingImpact).toContain(`#${a} blocked until #${b}`);
  });

  it("returns repository consistency risks and rejects purpose-incompatible relations", () => {
    const alpha = createProject(db, { name: "Alpha", createdBy: "lead" });
    const beta = createProject(db, { name: "Beta", createdBy: "lead" });
    linkProjectRepository(db, alpha, { repoRoot: "/workspace/alpha", repoName: "alpha" });
    linkProjectRepository(db, beta, { repoRoot: "/workspace/beta", repoName: "beta" });
    const source = task("Source", { projectId: alpha, workdir: "/workspace/alpha/pkg" });
    const target = task("Target", { projectId: beta, workdir: "/workspace/beta/pkg" });

    const result = linkTickets(db, {
      sourceTicketId: source,
      targetTicketId: target,
      relationType: "depends_on",
      reason: "release crosses repositories by explicit decision",
      actor: "lead",
    });
    expect(result.risks.join("\n")).toMatch(/repository_scope_mismatch/);

    const review = task("Review purpose", { purpose: "review" });
    const blocker = task("Blocker");
    expect(() => linkTickets(db, {
      sourceTicketId: review,
      targetTicketId: blocker,
      relationType: "depends_on",
      reason: "wrong purpose",
      actor: "lead",
    })).toThrow(/review-purpose/);

    const learning = task("Learning", { purpose: "learning" });
    expect(() => linkTickets(db, {
      sourceTicketId: blocker,
      targetTicketId: learning,
      relationType: "duplicates",
      reason: "different purpose",
      actor: "lead",
    })).toThrow(/matching ticket purpose/);
  });

  it("blocks dispatch and direct runs for dependencies and gated implementations", () => {
    const implementation = task("Implementation");
    const design = task("Design");
    linkTickets(db, {
      sourceTicketId: implementation,
      targetTicketId: design,
      relationType: "implements",
      reason: "implementation follows design",
      actor: "lead",
    });
    const implementsDispatcher = createDispatcher(db);
    implementsDispatcher.request({
      itemId: implementation,
      role: "executor",
      purpose: "execution",
      trigger: "test",
      idempotencyKey: "implements-dispatch",
    });
    expect(implementsDispatcher.claimNext()?.itemId).toBe(implementation);

    const gatedImplementation = task("Gated implementation");
    const designAcceptance = task("Design acceptance");
    const gatedRelation = linkTickets(db, {
      sourceTicketId: gatedImplementation,
      targetTicketId: designAcceptance,
      relationType: "implements",
      executionGate: "target_done",
      reason: "start only after design acceptance",
      actor: "lead",
    });
    expect(gatedRelation.schedulingImpact).toContain(
      `#${gatedImplementation} waits for #${designAcceptance} design acceptance`,
    );
    expect(getTicketRelations(db, gatedImplementation)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relatedItemId: designAcceptance,
        relationType: "implements",
        executionGate: "target_done",
      }),
    ]));
    expect(() => createRun(db, { itemId: gatedImplementation })).toThrow(
      new RegExp(`#${designAcceptance} \\[ready\\]`),
    );
    const gatedDispatcher = createDispatcher(db);
    gatedDispatcher.request({
      itemId: gatedImplementation,
      role: "executor",
      purpose: "execution",
      trigger: "test",
      idempotencyKey: "gated-implements-dispatch",
    });
    expect(gatedDispatcher.claimNext()).toBeNull();
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(designAcceptance);
    expect(gatedDispatcher.claimNext()?.itemId).toBe(gatedImplementation);

    const blocked = task("Blocked implementation");
    const blocker = task("Blocking design");
    const relation = linkTickets(db, {
      sourceTicketId: blocked,
      targetTicketId: blocker,
      relationType: "depends_on",
      reason: "must finish design first",
      actor: "lead",
    });
    const dispatcher = createDispatcher(db);
    dispatcher.request({
      itemId: blocked,
      role: "executor",
      purpose: "execution",
      trigger: "test",
      idempotencyKey: "depends-dispatch",
    });
    expect(dispatcher.claimNext()).toBeNull();
    expect(listActivities(db, blocked).map((activity) => JSON.parse(activity.payload))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        decision: "dispatch_blocked_by_ticket_relation",
        blockers: [expect.objectContaining({ ticketId: blocker })],
      }),
    ]));
    expect(() => createRun(db, { itemId: blocked })).toThrow(new RegExp(`#${blocker} \\[ready\\]`));

    revokeTicketRelation(db, { relationId: relation.relation.id, reason: "manual override", actor: "lead" });
    expect(dispatcher.claimNext()?.itemId).toBe(blocked);

    const blockedByDone = task("Blocked by done");
    const doneBlocker = task("Done blocker");
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(doneBlocker);
    linkTickets(db, {
      sourceTicketId: blockedByDone,
      targetTicketId: doneBlocker,
      relationType: "depends_on",
      reason: "already satisfied",
      actor: "lead",
    });
    const doneDispatcher = createDispatcher(db);
    doneDispatcher.request({
      itemId: blockedByDone,
      role: "executor",
      purpose: "execution",
      trigger: "test",
      idempotencyKey: "depends-done-dispatch",
    });
    expect(doneDispatcher.claimNext()?.itemId).toBe(blockedByDone);
  });

  it("rejects duplicate dependency semantics for the same implementation pair", () => {
    const implementation = task("Implementation");
    const design = task("Design");
    linkTickets(db, {
      sourceTicketId: implementation,
      targetTicketId: design,
      relationType: "implements",
      executionGate: "target_done",
      reason: "implementation waits for accepted design",
      actor: "lead",
    });
    expect(() => linkTickets(db, {
      sourceTicketId: implementation,
      targetTicketId: design,
      relationType: "depends_on",
      reason: "duplicate wait semantics",
      actor: "lead",
    })).toThrow(/one implements relation/);
  });

  it("migrates an implements plus depends_on pair into one gated implementation", () => {
    const dir = tempDir("plc-relations-v19-");
    const path = join(dir, "plc.db");
    const legacy = openDb(path);
    const implementation = createItem(legacy, { title: "Implementation", brief: "b", createdBy: "lead" });
    const design = createItem(legacy, { title: "Design", brief: "b", createdBy: "lead" });
    legacy.prepare(
      `INSERT INTO ticket_relations
       (source_item_id, target_item_id, relation_type, execution_gate, created_by, reason)
       VALUES (?, ?, 'implements', 'none', 'lead', 'implements design')`,
    ).run(implementation, design);
    legacy.prepare(
      `INSERT INTO ticket_relations
       (source_item_id, target_item_id, relation_type, execution_gate, created_by, reason)
       VALUES (?, ?, 'depends_on', 'none', 'lead', 'wait for design')`,
    ).run(implementation, design);
    legacy.prepare("DELETE FROM schema_migrations WHERE version=19").run();
    legacy.close();

    const migrated = openDb(path);
    try {
      const rows = migrated.prepare(
        `SELECT relation_type, execution_gate, revoked_at, revoked_by, revoke_reason
         FROM ticket_relations ORDER BY id`,
      ).all() as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        expect.objectContaining({
          relation_type: "implements",
          execution_gate: "target_done",
          revoked_at: null,
        }),
        expect.objectContaining({
          relation_type: "depends_on",
          revoked_at: expect.any(String),
          revoked_by: "system",
          revoke_reason: "migrated to implements.execution_gate=target_done in v19",
        }),
      ]);
      expect(migrated.prepare("SELECT name FROM schema_migrations WHERE version=19").get())
        .toEqual({ name: "relation-execution-gate-v1" });
    } finally {
      migrated.close();
    }
  });

  it("enforces duplicate canonical constraints without merging history", () => {
    const canonical = task("Canonical");
    const duplicate = task("Duplicate");
    const otherCanonical = task("Other canonical");
    const another = task("Another duplicate");
    linkTickets(db, {
      sourceTicketId: duplicate,
      targetTicketId: canonical,
      relationType: "duplicates",
      reason: "same work",
      actor: "lead",
    });
    expect(canonicalDuplicateOf(db, duplicate)).toBe(canonical);
    expect(duplicateSourcesFor(db, canonical)).toEqual([duplicate]);
    expect(getItem(db, duplicate)).toBeDefined();
    expect(() => linkTickets(db, {
      sourceTicketId: duplicate,
      targetTicketId: otherCanonical,
      relationType: "duplicates",
      reason: "choose a different canonical",
      actor: "lead",
    })).toThrow(/already points at canonical/);

    linkTickets(db, {
      sourceTicketId: canonical,
      targetTicketId: another,
      relationType: "duplicated_by",
      reason: "canonical collects another duplicate",
      actor: "lead",
    });
    expect(duplicateSourcesFor(db, canonical).sort()).toEqual([duplicate, another].sort());
    expect(() => linkTickets(db, {
      sourceTicketId: canonical,
      targetTicketId: another,
      relationType: "duplicates",
      reason: "canonical cannot duplicate a duplicate",
      actor: "lead",
    })).toThrow(/canonical ticket cannot itself duplicate/);
    expect(() => linkTickets(db, {
      sourceTicketId: task("Duplicate of duplicate"),
      targetTicketId: duplicate,
      relationType: "duplicates",
      reason: "wrong target",
      actor: "lead",
    })).toThrow(/link to the canonical ticket directly/);
  });

  it("records supersedes as the current effective ticket without deleting the old one", () => {
    const old = task("Old");
    const replacement = task("Replacement");
    const otherReplacement = task("Other replacement");
    linkTickets(db, {
      sourceTicketId: replacement,
      targetTicketId: old,
      relationType: "supersedes",
      reason: "new approach accepted",
      actor: "lead",
    });
    expect(supersededBy(db, old)).toBe(replacement);
    expect(getItem(db, old)).toBeDefined();
    expect(() => linkTickets(db, {
      sourceTicketId: otherReplacement,
      targetTicketId: old,
      relationType: "supersedes",
      reason: "second current item",
      actor: "lead",
    })).toThrow(/UNIQUE|constraint|supersedes/i);
    expect(() => linkTickets(db, {
      sourceTicketId: old,
      targetTicketId: replacement,
      relationType: "supersedes",
      reason: "cycle",
      actor: "lead",
    })).toThrow(/already superseded|cycle/);
  });

  it("keeps relates_to out of scheduling and completion semantics", () => {
    const a = task("A");
    const b = task("B");
    linkTickets(db, {
      sourceTicketId: a, targetTicketId: b, relationType: "relates_to", reason: "navigation only", actor: "lead",
    });
    const dispatcher = createDispatcher(db);
    dispatcher.request({
      itemId: a,
      role: "executor",
      purpose: "execution",
      trigger: "test",
      idempotencyKey: "relates-dispatch",
    });
    expect(dispatcher.claimNext()?.itemId).toBe(a);
  });

  it("adapts parent relations from the tree without copying them into ticket_relations", () => {
    const parent = task("Parent");
    const child = task("Child", { parentItemId: parent, rootItemId: parent });
    expect(getTicketRelations(db, parent)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relationId: null,
        relatedItemId: child,
        relationType: "parent_of",
        factSource: "tree",
      }),
    ]));
    expect(getTicketRelations(db, child)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relationId: null,
        relatedItemId: parent,
        relationType: "child_of",
        factSource: "tree",
      }),
    ]));
    expect((db.prepare("SELECT COUNT(*) AS n FROM ticket_relations").get() as { n: number }).n).toBe(0);
  });

  it("uses duplicate canonical hints during tree restore without pulling ordinary relations into scope", () => {
    const root = task("Root");
    const canonical = task("Canonical child", { parentItemId: root, rootItemId: root });
    const duplicate = task("Duplicate child", { parentItemId: root, rootItemId: root });
    const outside = task("Outside related");
    linkTickets(db, {
      sourceTicketId: duplicate,
      targetTicketId: canonical,
      relationType: "duplicates",
      reason: "same child work",
      actor: "lead",
    });
    linkTickets(db, {
      sourceTicketId: canonical,
      targetTicketId: outside,
      relationType: "relates_to",
      reason: "navigation only",
      actor: "lead",
    });
    for (const id of [root, canonical, duplicate, outside]) {
      transition(db, { itemId: id, to: "cancelled", actor: "lead", reason: "test restore" });
    }

    expect(previewItemRestore(db, root)).toMatchObject({
      suggestedChildIds: [canonical],
      duplicateGroups: [[canonical, duplicate]],
    });
    const restored = restoreItemTree(db, {
      itemId: root,
      mode: "review_tree",
      requestedBy: "test",
    });
    expect(restored.restoredItemIds.sort()).toEqual([root, canonical].sort());
    expect(getItem(db, duplicate)?.stage).toBe("cancelled");
    expect(getItem(db, outside)?.stage).toBe("cancelled");
  });

  it("audits link and revoke operations through activities", () => {
    const a = task("A");
    const b = task("B");
    const result = linkTickets(db, {
      sourceTicketId: a, targetTicketId: b, relationType: "depends_on", reason: "audit", actor: "lead",
    });
    revokeTicketRelation(db, { relationId: result.relation.id, reason: "audit revoke", actor: "lead" });
    const decisions = listActivities(db, a).filter((activity) => activity.kind === "decision");
    expect(decisions.map((activity) => JSON.parse(activity.payload).decision)).toEqual([
      "link_ticket_relation",
      "revoke_ticket_relation",
    ]);
  });

  it("is idempotent across separate connections for the same active relation", () => {
    const dir = tempDir("plc-relations-concurrent-");
    const path = join(dir, "plc.db");
    const firstDb = openDb(path);
    const secondDb = openDb(path);
    try {
      const source = createItem(firstDb, { title: "source", brief: "b", createdBy: "lead" });
      const target = createItem(firstDb, { title: "target", brief: "b", createdBy: "lead" });
      const first = linkTickets(firstDb, {
        sourceTicketId: source,
        targetTicketId: target,
        relationType: "depends_on",
        reason: "same call",
        actor: "lead",
      });
      const second = linkTickets(secondDb, {
        sourceTicketId: source,
        targetTicketId: target,
        relationType: "depends_on",
        reason: "same call",
        actor: "lead",
      });
      expect(second.status).toBe("existing");
      expect(second.relation.id).toBe(first.relation.id);
      expect((firstDb.prepare("SELECT COUNT(*) AS n FROM ticket_relations").get() as { n: number }).n).toBe(1);
    } finally {
      firstDb.close();
      secondDb.close();
    }
  });
});
