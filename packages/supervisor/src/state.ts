import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { SupervisorPersistentState } from "./protocol.js";

function initialState(now = new Date()): SupervisorPersistentState {
  return {
    version: 1,
    desiredState: "running",
    phase: "starting",
    supervisorPid: null,
    daemonPid: null,
    crashCount: 0,
    lastDaemonExit: null,
    maintenance: null,
    updatedAt: now.toISOString(),
  };
}

export function loadSupervisorState(path: string): SupervisorPersistentState {
  if (!existsSync(path)) return initialState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SupervisorPersistentState>;
    if (parsed.version !== 1) return initialState();
    // 上一个 supervisor 在维护途中停了：那次维护没有完成，记成 interrupted。
    // 不改的话，这条 running 的记录会让人以为维护还在进行。
    const maintenance = parsed.maintenance?.state === "running"
      ? {
          ...parsed.maintenance,
          state: "interrupted" as const,
          completedAt: new Date().toISOString(),
          error: "interrupted: the supervisor stopped while this maintenance was running",
        }
      : parsed.maintenance ?? null;
    return {
      ...initialState(),
      ...parsed,
      maintenance,
      supervisorPid: null,
      daemonPid: null,
      phase: parsed.desiredState === "stopped" ? "stopped" : "starting",
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return initialState();
  }
}

export function saveSupervisorState(path: string, state: SupervisorPersistentState): void {
  state.updatedAt = new Date().toISOString();
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

