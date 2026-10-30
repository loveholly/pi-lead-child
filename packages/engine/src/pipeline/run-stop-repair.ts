import type { Db } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { createCoordinator } from "../coordinator/service.js";
import { updateRun } from "@pi-lead-child/store";

export function repairStoppedRunCrashCheckpoints(db: Db): number {
  const rows = db.prepare(
    `SELECT c.id AS checkpoint_id, c.item_id, c.run_id, r.state
     FROM checkpoints c
     JOIN runs r ON r.id=c.run_id
     WHERE c.source='system_derived'
       AND c.kind='blocked'
       AND c.idempotency_key='run-crash:' || c.run_id
       AND r.state IN ('stopped','paused')
       AND r.error_code='interrupted'`,
  ).all() as Array<{
    checkpoint_id: number;
    item_id: number;
    run_id: number;
    state: "stopped" | "paused";
  }>;
  const coordinator = createCoordinator({ db });
  for (const row of rows) {
    db.transaction(() => {
      db.prepare("DELETE FROM conversation_cards WHERE checkpoint_id=?").run(row.checkpoint_id);
      db.prepare("DELETE FROM checkpoints WHERE id=?").run(row.checkpoint_id);
      updateRun(db, row.run_id, { errorCode: null, errorMessage: null, exitCode: null });
      addActivity(db, {
        itemId: row.item_id,
        runId: row.run_id,
        actor: "system",
        kind: "decision",
        payload: {
          decision: "false_crash_projection_repaired",
          removedCheckpointId: row.checkpoint_id,
          runState: row.state,
          reason: "late interrupted event arrived after the user lifecycle action had settled the run",
        },
      });
      coordinator.recordSystemCheckpoint({
        itemId: row.item_id,
        runId: row.run_id,
        kind: "decision",
        title: row.state === "paused" ? "Run paused" : "Run stopped",
        summary: `Run #${row.run_id} was ${row.state} by the user; the later interrupted event is not a crash.`,
        nextStep: row.state === "paused" ? "Resume this run when the user is ready." : null,
        idempotencyKey: `run-${row.state}:${row.run_id}`,
        leadVisible: false,
      });
    }).immediate();
  }
  return rows.length;
}
