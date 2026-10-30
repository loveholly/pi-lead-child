// 故障的恢复（2026-10-20 去掉金丝雀以后）：探针通过就关闭故障。
// 探针看不到的故障（余额、额度）关闭后马上又同样失败时，并回那次故障：退避加倍，不再通知用户。
// 旧数据里停在金丝雀阶段的故障由恢复 tick 关闭，重复调用不多关。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { TypedFailure } from "@pi-lead-child/core";
import { openDb, type Db } from "../src/db.js";
import { createItem } from "../src/items.js";
import {
  closeLegacyCanaryIncidents, getRuntimeIncident, LEGACY_CANARY_CLOSE_REASON, PROBE_PASSED_REASON, recordProbeResult,
  recordRuntimeHealthFailure, RECHECK_PASSED_REASON, unavailableIncident,
} from "../src/runtime-health.js";

let db: Db;
let itemId: number;
const profile = { runtime: "codex" as const, executable: "/usr/local/bin/codex", configDir: null, version: "0.153.3" };
const outOfCredits: TypedFailure = {
  scope: "account", retry: "never", needs: "refill", code: "out_of_credits",
  evidence: "unexpected status 402 Payment Required: Payment Required",
};
const loggedOut: TypedFailure = {
  scope: "account", retry: "never", needs: "login", code: "auth_required", evidence: "codex login status exited with code 1",
};
const MINUTE = 60_000;

beforeEach(() => {
  db = openDb(join(tempDir("plc-incident-recovery-"), "plc.db"));
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
});

const notifications = () => (db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n;
// 给 Lead 的最新一条这种说明。
const leadNote = (kind: string) => {
  const row = db.prepare(
    "SELECT summary, payload FROM inbox WHERE json_extract(payload, '$.kind')=? ORDER BY id DESC LIMIT 1",
  ).get(kind) as { summary: string; payload: string };
  return { summary: row.summary, payload: JSON.parse(row.payload) as Record<string, unknown> };
};
const at = (offsetMs: number) => new Date(Date.parse("2026-10-20T08:00:00.000Z") + offsetMs);

describe("a passing probe", () => {
  it("closes the incident and releases the profile", () => {
    const { incident } = recordRuntimeHealthFailure(db, {
      profile, model: null, itemId, runId: null, failure: loggedOut, at: at(0),
    })!;
    const closed = recordProbeResult(db, incident.id, { ok: true, detail: null, at: at(MINUTE) });
    expect(closed).toMatchObject({ closed_at: at(MINUTE).toISOString(), close_reason: PROBE_PASSED_REASON });
    expect(unavailableIncident(db, { profile, model: null })).toBeNull();
    // 已经关闭：再来一次探针结果作废。
    expect(recordProbeResult(db, incident.id, { ok: true, detail: null, at: at(2 * MINUTE) })).toBeNull();
  });

  it("closes the incident with the recheck reason when the user rechecked", () => {
    const { incident } = recordRuntimeHealthFailure(db, {
      profile, model: null, itemId, runId: null, failure: loggedOut, at: at(0),
    })!;
    expect(recordProbeResult(db, incident.id, { ok: true, detail: null, at: at(0), manual: true }))
      .toMatchObject({ close_reason: RECHECK_PASSED_REASON });
  });
});

describe("the same failure right after a probe closed the incident", () => {
  it("reopens that incident, waits twice as long and does not notify the user again", () => {
    const { incident } = recordRuntimeHealthFailure(db, {
      profile, model: null, itemId, runId: null, failure: outOfCredits, at: at(0),
    })!;
    expect(notifications()).toBe(1);
    // 探针看不到余额：通过，故障关闭，挂起的请求放出去，又撞上同一个故障。
    recordProbeResult(db, incident.id, { ok: true, detail: null, at: at(MINUTE) });
    const again = recordRuntimeHealthFailure(db, {
      profile, model: null, itemId, runId: null, failure: outOfCredits, at: at(MINUTE + 5_000),
    })!;
    expect(again).toMatchObject({ opened: false, incident: { id: incident.id, closed_at: null, probe_failures: 1 } });
    expect(again.incident.next_probe_at).toBe(at(MINUTE + 5_000 + 2 * MINUTE).toISOString());
    expect(unavailableIncident(db, { profile, model: null })?.id).toBe(incident.id);
    expect(notifications()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_incidents").get()).toEqual({ n: 1 });
  });

  // 回归（2026-10-21 审查）：探针看不到余额和额度，关闭时却对 Lead 说「已恢复」，Lead 可能转告用户；
  // 重新开启的说明又不叫醒 Lead，它一直以为已经恢复。
  it("tells Lead the release is unconfirmed for a fault the probe cannot see", () => {
    const { incident } = recordRuntimeHealthFailure(db, {
      profile, model: null, itemId, runId: null, failure: outOfCredits, at: at(0),
    })!;
    recordProbeResult(db, incident.id, { ok: true, detail: null, at: at(MINUTE) });
    const closed = leadNote("runtime_incident_closed");
    expect(closed.summary).toContain("结果待确认");
    expect(closed.summary).not.toContain("已恢复");
    expect(closed.payload).toMatchObject({ unconfirmed: true });

    recordRuntimeHealthFailure(db, { profile, model: null, itemId, runId: null, failure: outOfCredits, at: at(MINUTE + 5_000) });
    // 关闭时没有说已经恢复：重新开启只记一笔，不叫醒 Lead。
    expect(leadNote("runtime_incident_reopened").payload.wakeLead).not.toBe(true);
  });

  it("wakes Lead when an incident it was told had recovered fails the same way again", () => {
    const { incident } = recordRuntimeHealthFailure(db, {
      profile, model: null, itemId, runId: null, failure: loggedOut, at: at(0),
    })!;
    recordProbeResult(db, incident.id, { ok: true, detail: null, at: at(MINUTE) });
    expect(leadNote("runtime_incident_closed").summary).toContain("已恢复");

    recordRuntimeHealthFailure(db, { profile, model: null, itemId, runId: null, failure: loggedOut, at: at(MINUTE + 5_000) });
    expect(leadNote("runtime_incident_reopened").payload).toMatchObject({ wakeLead: true, incidentId: incident.id });
    expect(notifications()).toBe(1);
  });

  it("opens a new incident for a different failure, or once the backoff window has passed", () => {
    const { incident } = recordRuntimeHealthFailure(db, {
      profile, model: null, itemId, runId: null, failure: outOfCredits, at: at(0),
    })!;
    recordProbeResult(db, incident.id, { ok: true, detail: null, at: at(MINUTE) });
    const other = recordRuntimeHealthFailure(db, {
      profile, model: null, itemId, runId: null, failure: loggedOut, at: at(2 * MINUTE),
    })!;
    expect(other.opened).toBe(true);
    recordProbeResult(db, other.incident.id, { ok: true, detail: null, at: at(3 * MINUTE) });
    const later = recordRuntimeHealthFailure(db, {
      profile, model: null, itemId, runId: null, failure: loggedOut, at: at(3 * MINUTE + 2 * 60 * MINUTE),
    })!;
    expect(later.opened).toBe(true);
    expect(later.incident.id).not.toBe(other.incident.id);
  });
});

describe("incidents left waiting for a canary before 2026-10-20", () => {
  it("are closed once by the recovery tick, and only those", () => {
    const armed = recordRuntimeHealthFailure(db, {
      profile, model: null, itemId, runId: null, failure: loggedOut, at: at(0),
    })!.incident;
    const probing = recordRuntimeHealthFailure(db, {
      profile, model: "gpt-5.4-mini", itemId, runId: null, at: at(0),
      failure: { scope: "runtime", retry: "never", needs: "config", code: "model_unsupported", evidence: "unknown model" },
    })!.incident;
    db.prepare("UPDATE runtime_incidents SET canary_armed_at=? WHERE id=?").run(at(0).toISOString(), armed.id);

    expect(closeLegacyCanaryIncidents(db, at(MINUTE))).toEqual([armed.id]);
    expect(closeLegacyCanaryIncidents(db, at(2 * MINUTE))).toEqual([]);
    expect(getRuntimeIncident(db, armed.id)).toMatchObject({
      closed_at: at(MINUTE).toISOString(), close_reason: LEGACY_CANARY_CLOSE_REASON,
    });
    expect(getRuntimeIncident(db, probing.id)?.closed_at).toBeNull();
    expect(unavailableIncident(db, { profile, model: null })).toBeNull();
  });

  // 回归（2026-10-21 审查 H1）：关闭时没有清掉金丝雀字段。同样的失败把故障并回去以后，它还带着 canary_armed_at，
  // 下一次恢复 tick（每 5 秒）又把它关闭，挂起的派发又放出去撞同一个故障，循环下去。
  it("are not closed again after the same failure reopens them", () => {
    const armed = recordRuntimeHealthFailure(db, {
      profile, model: null, itemId, runId: null, failure: outOfCredits, at: at(0),
    })!.incident;
    db.prepare("UPDATE runtime_incidents SET canary_armed_at=?, canary_run_id=NULL WHERE id=?").run(at(0).toISOString(), armed.id);

    expect(closeLegacyCanaryIncidents(db, at(MINUTE))).toEqual([armed.id]);
    expect(getRuntimeIncident(db, armed.id)).toMatchObject({ canary_armed_at: null, canary_run_id: null });
    const again = recordRuntimeHealthFailure(db, {
      profile, model: null, itemId, runId: null, failure: outOfCredits, at: at(MINUTE + 5_000),
    })!;
    expect(again).toMatchObject({ opened: false, incident: { id: armed.id, closed_at: null } });

    expect(closeLegacyCanaryIncidents(db, at(MINUTE + 10_000))).toEqual([]);
    expect(unavailableIncident(db, { profile, model: null })?.id).toBe(armed.id);
  });
});
