import { createHash } from "node:crypto";
import { isAbsolute, normalize, resolve, sep, win32 } from "node:path";
import { addActivity } from "./activities.js";
import type { Db } from "./db.js";
import type { Item, Run } from "@pi-lead-child/core";

export const OUTCOME_SENTINEL = "PLC_OUTCOME_V1";

export type OutcomeChangeKind = "file" | "commit" | "other";
export type OutcomeDeliverableKind = "artifact" | "path" | "url" | "other";
export type OutcomeValidationOutcome = "passed" | "failed" | "not_run";
export type OutcomeSnapshotSource = "agent_reported" | "system_recovered";
export type OutcomeCompleteness = "complete" | "partial";

export interface OutcomeChange {
  kind: OutcomeChangeKind;
  ref: string;
  summary: string | null;
}

export interface OutcomeDeliverable {
  kind: OutcomeDeliverableKind;
  ref: string;
  label: string;
}

export interface OutcomeValidation {
  command: string;
  outcome: OutcomeValidationOutcome;
  exitCode: number | null;
  summary: string;
  evidenceRef: string | null;
}

export interface OutcomePayload {
  summary: string;
  changes: OutcomeChange[];
  deliverables: OutcomeDeliverable[];
  validations: OutcomeValidation[];
}

// 规范化改动了输入时，留下诊断（spec D3）。每一处改动记一条诊断。
// received 是有长度上限的原始值。疑似凭据时，它写成 [redacted]。
export type OutcomeDiagnosticCode =
  | "synonym_mapped"    // 已知近义值映射成规范值
  | "unknown_value"     // 未知枚举值降级成兜底值
  | "unknown_field"     // 未知字段被忽略
  | "invalid_entry"     // 列表里的一条记录无效，被丢弃
  | "invalid_field"     // 一个字段无效：可选字段置空，列表字段记为空列表
  | "too_many_entries"; // 列表超过上限，被截断

export interface OutcomeDiagnostic {
  field: string;
  code: OutcomeDiagnosticCode;
  received: string | null;
  normalized: string | null;
  reason: string | null;
}

export interface NormalizedOutcomePayload extends OutcomePayload {
  completeness: OutcomeCompleteness;
  missingFields: string[];
  // 只在有改动时出现。规范的输入因此得到和以前完全相同的对象，ticket_update 的请求指纹不变。
  diagnostics?: OutcomeDiagnostic[];
}

export interface OutcomeSnapshot extends Omit<NormalizedOutcomePayload, "diagnostics"> {
  id: number;
  itemId: number;
  executorRunId: number;
  completionCheckpointId: number | null;
  source: OutcomeSnapshotSource;
  sourceEventSeq: number | null;
  sourceOutputSha256: string | null;
  recoveryNote: string | null;
  contentHash: string;
  idempotencyKey: string;
  createdAt: string;
}

interface OutcomeSnapshotRow {
  id: number;
  item_id: number;
  executor_run_id: number;
  completion_checkpoint_id: number | null;
  source: OutcomeSnapshotSource;
  source_event_seq: number | null;
  source_output_sha256: string | null;
  summary: string;
  changes_json: string;
  deliverables_json: string;
  validations_json: string;
  completeness: OutcomeCompleteness;
  missing_fields_json: string;
  recovery_note: string | null;
  content_hash: string;
  idempotency_key: string;
  created_at: string;
}

export interface InsertOutcomeSnapshotInput {
  itemId: number;
  executorRunId: number;
  completionCheckpointId?: number | null;
  source: OutcomeSnapshotSource;
  sourceEventSeq?: number | null;
  sourceOutputSha256?: string | null;
  recoveryNote?: string | null;
  outcome: NormalizedOutcomePayload;
  idempotencyKey?: string;
  now?: Date;
}

export interface InsertOutcomeSnapshotResult {
  snapshot: OutcomeSnapshot;
  deduplicated: boolean;
}

const MAX_ITEMS = 50;
const MAX_TEXT = 2_000;
const MAX_REF = 4_096;
const OUTCOME_KEYS = new Set(["summary", "changes", "deliverables", "validations"]);
const CHANGE_KEYS = new Set(["kind", "ref", "summary"]);
const DELIVERABLE_KEYS = new Set(["kind", "ref", "label"]);
const VALIDATION_KEYS = new Set(["command", "outcome", "exitCode", "exit_code", "summary", "evidenceRef", "evidence_ref"]);
const CHANGE_KINDS = new Set<OutcomeChangeKind>(["file", "commit", "other"]);
const DELIVERABLE_KINDS = new Set<OutcomeDeliverableKind>(["artifact", "path", "url", "other"]);
const VALIDATION_OUTCOMES = new Set<OutcomeValidationOutcome>(["passed", "failed", "not_run"]);
// 已知近义值（spec D3）。用 Map 而不是对象字面量：输入是不可信的字符串，"constructor" 不能命中原型链。
const VALIDATION_SYNONYMS = new Map<string, OutcomeValidationOutcome>([
  ["skipped", "not_run"],
  ["pass", "passed"],
  ["fail", "failed"],
]);
const NO_SYNONYMS = new Map<string, never>();
const MAX_RECEIVED = 80;
const SECRET_PATTERN = /(?:\b(?:[a-z0-9_-]*token|api[_-]?key|secret|password|passwd)\b\s*[:=]\s*\S+|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{8,})/i;

// 诊断里的原始值。字符串先检查凭据，再截断：截断后再检查，会漏掉跨过截断点的凭据。
// 对象和数组只记类型和大小。SECRET_PATTERN 认不出 JSON 形式的凭据，所以它们的内容不进诊断。
function describeReceived(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value !== null && typeof value === "object") return "object";
  const text = typeof value === "string" ? value.trim() : String(value);
  if (SECRET_PATTERN.test(text)) return "[redacted]";
  return Array.from(text).slice(0, MAX_RECEIVED).join("");
}

// 宽松的枚举读取：规范值原样通过；已知近义值（大小写不敏感）做映射；其余降级成 fallback。
// 映射和降级都记一条诊断。
function enumValue<T extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlySet<T>,
  synonyms: ReadonlyMap<string, T>,
  fallback: T,
  diagnostics: OutcomeDiagnostic[],
): T {
  if (typeof value === "string" && allowed.has(value as T)) return value as T;
  const key = typeof value === "string" ? value.trim().toLowerCase() : null;
  const mapped = key === null ? undefined : allowed.has(key as T) ? key as T : synonyms.get(key);
  diagnostics.push({
    field,
    code: mapped ? "synonym_mapped" : "unknown_value",
    received: describeReceived(value),
    normalized: mapped ?? fallback,
    reason: null,
  });
  return mapped ?? fallback;
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
}

// 未知字段不进账本，只记诊断。字段名来自不可信输入，所以只放进 received，不拼进 field 路径。
function ignoreUnknownKeys(
  value: Record<string, unknown>, allowed: Set<string>, field: string, diagnostics: OutcomeDiagnostic[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      diagnostics.push({ field, code: "unknown_field", received: describeReceived(key), normalized: null, reason: null });
    }
  }
}

// 校验函数的报错只含字段路径，不含输入值，所以可以原样写进诊断。
function errorReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

// 可选字段出错时置空，并记一条诊断。整条记录保留。
function optionalField<T>(field: string, diagnostics: OutcomeDiagnostic[], read: () => T | null): T | null {
  try {
    return read();
  } catch (error) {
    diagnostics.push({ field, code: "invalid_field", received: null, normalized: null, reason: errorReason(error) });
    return null;
  }
}

// 宽松地读一个列表字段（spec D3：一个字段出错，不作废整份信封）。
// 不是数组时记为空列表；超过上限时截断；一条记录出错时只丢弃这一条。
// 被丢弃的记录只留一条 invalid_entry 诊断，它自己的其他诊断不再保留。
// lost 表示列表丢了记录。调用方把这个字段记为不完整。
function lenientList<T>(
  value: unknown,
  field: string,
  keys: Set<string>,
  diagnostics: OutcomeDiagnostic[],
  readEntry: (raw: Record<string, unknown>, entryField: string, entryDiagnostics: OutcomeDiagnostic[]) => T,
): { entries: T[]; lost: boolean } {
  if (!Array.isArray(value)) {
    diagnostics.push({
      field, code: "invalid_field", received: describeReceived(value), normalized: null,
      reason: `${field} must be an array`,
    });
    return { entries: [], lost: true };
  }
  if (value.length > MAX_ITEMS) {
    diagnostics.push({
      field, code: "too_many_entries", received: String(value.length), normalized: String(MAX_ITEMS),
      reason: `${field} may contain at most ${MAX_ITEMS} entries`,
    });
  }
  const entries: T[] = [];
  let lost = value.length > MAX_ITEMS;
  value.slice(0, MAX_ITEMS).forEach((raw: unknown, index) => {
    const entryField = `${field}[${index}]`;
    const entryDiagnostics: OutcomeDiagnostic[] = [];
    try {
      assertRecord(raw, entryField);
      ignoreUnknownKeys(raw, keys, entryField, entryDiagnostics);
      entries.push(readEntry(raw, entryField, entryDiagnostics));
      diagnostics.push(...entryDiagnostics);
    } catch (error) {
      lost = true;
      diagnostics.push({ field: entryField, code: "invalid_entry", received: null, normalized: null, reason: errorReason(error) });
    }
  });
  return { entries, lost };
}

function boundedString(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (Array.from(trimmed).length > max) throw new Error(`${field} is too long`);
  if (SECRET_PATTERN.test(trimmed)) throw new Error(`${field} appears to contain secret-bearing data`);
  return trimmed;
}

function nullableBoundedString(value: unknown, field: string, max = MAX_TEXT): string | null {
  if (value === null || value === undefined) return null;
  return boundedString(value, field, max);
}

function assertRelativeWorkdirPath(ref: string, field: string, workdir?: string | null): void {
  if (/[\u0000-\u001f\u007f]/.test(ref)) throw new Error(`${field} contains control characters`);
  if (isAbsolute(ref) || win32.isAbsolute(ref) || /^[A-Za-z]:/.test(ref)) {
    throw new Error(`${field} must be a workdir-relative path`);
  }
  const parts = ref.split(/[\\/]+/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${field} must not contain empty, '.', or '..' segments`);
  }
  if (!workdir) return;
  const base = resolve(workdir);
  const target = resolve(base, normalize(ref));
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  if (target !== base && !target.startsWith(prefix)) {
    throw new Error(`${field} escapes the item workdir`);
  }
}

function assertUrl(ref: string, field: string): void {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${field} URL must use http or https`);
  }
}

// 对输出严格：ref 不合规的记录不进账本，只丢弃这一条。
// 不合规包括越出 workdir、不是 http 或 https 的 URL、疑似凭据。
// 未知的 kind 降级成 other。这和 agent 自己写 other 一样，不做路径或 URL 校验。
function readChange(
  raw: Record<string, unknown>, field: string, workdir: string | null | undefined, diagnostics: OutcomeDiagnostic[],
): OutcomeChange {
  const kind = enumValue(raw.kind, `${field}.kind`, CHANGE_KINDS, NO_SYNONYMS, "other", diagnostics);
  const ref = boundedString(raw.ref, `${field}.ref`, MAX_REF);
  if (kind === "file") assertRelativeWorkdirPath(ref, `${field}.ref`, workdir);
  return {
    kind,
    ref,
    summary: optionalField(`${field}.summary`, diagnostics, () => nullableBoundedString(raw.summary, `${field}.summary`, 500)),
  };
}

function readDeliverable(
  raw: Record<string, unknown>, field: string, workdir: string | null | undefined, diagnostics: OutcomeDiagnostic[],
): OutcomeDeliverable {
  const kind = enumValue(raw.kind, `${field}.kind`, DELIVERABLE_KINDS, NO_SYNONYMS, "other", diagnostics);
  const ref = boundedString(raw.ref, `${field}.ref`, MAX_REF);
  if (kind === "path") assertRelativeWorkdirPath(ref, `${field}.ref`, workdir);
  if (kind === "url") assertUrl(ref, `${field}.ref`);
  return { kind, ref, label: boundedString(raw.label, `${field}.label`, 240) };
}

function readExitCode(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative integer or null`);
  }
  return Number(value);
}

// 未知的验证结果降级成 not_run：不确定时，绝不声称验证通过了。
function readValidation(raw: Record<string, unknown>, field: string, diagnostics: OutcomeDiagnostic[]): OutcomeValidation {
  const outcome = enumValue(raw.outcome, `${field}.outcome`, VALIDATION_OUTCOMES, VALIDATION_SYNONYMS, "not_run", diagnostics);
  const command = boundedString(raw.command, `${field}.command`, 1_000);
  const summary = boundedString(raw.summary, `${field}.summary`, 1_000);
  return {
    command,
    outcome,
    exitCode: optionalField(`${field}.exitCode`, diagnostics, () => readExitCode(raw.exitCode ?? raw.exit_code, `${field}.exitCode`)),
    summary,
    evidenceRef: optionalField(`${field}.evidenceRef`, diagnostics,
      () => nullableBoundedString(raw.evidenceRef ?? raw.evidence_ref, `${field}.evidenceRef`, 500)),
  };
}

export { isOutcomeNormalizeError } from "@pi-lead-child/core";

export function normalizeOutcomePayload(
  raw: unknown,
  options: {
    workdir?: string | null;
    allowPartial?: boolean;
  } = {},
): NormalizedOutcomePayload {
  assertRecord(raw, "outcome");
  const diagnostics: OutcomeDiagnostic[] = [];
  ignoreUnknownKeys(raw, OUTCOME_KEYS, "outcome", diagnostics);
  const allowPartial = options.allowPartial === true;
  const missingFields = ["changes", "deliverables", "validations"]
    .filter((field) => raw[field] === undefined);
  if (raw.summary === undefined) missingFields.unshift("summary");
  if (!allowPartial && missingFields.length > 0) {
    throw new Error(`outcome is missing required field(s): ${missingFields.join(", ")}`);
  }
  // summary 是成果的核心。它缺失或无效时，整份信封无效。其他字段出错只影响自己。
  if (raw.summary === undefined) throw new Error("outcome.summary is required");
  const summary = boundedString(raw.summary, "outcome.summary", MAX_TEXT);
  // 对输出严格：列表丢了记录，这个字段就和缺失一样不完整，成果因此是 partial。
  // 否则一条被丢弃的失败验证会消失，工单却按 complete 被推进到 review。
  const lostFields = new Set<string>();
  const list = <T>(
    name: "changes" | "deliverables" | "validations",
    keys: Set<string>,
    readEntry: (entry: Record<string, unknown>, field: string, entryDiagnostics: OutcomeDiagnostic[]) => T,
  ): T[] => {
    if (raw[name] === undefined) return [];
    const result = lenientList(raw[name], `outcome.${name}`, keys, diagnostics, readEntry);
    if (result.lost) lostFields.add(name);
    return result.entries;
  };
  const changes = list("changes", CHANGE_KEYS,
    (entry, field, entryDiagnostics) => readChange(entry, field, options.workdir, entryDiagnostics));
  const deliverables = list("deliverables", DELIVERABLE_KEYS,
    (entry, field, entryDiagnostics) => readDeliverable(entry, field, options.workdir, entryDiagnostics));
  const validations = list("validations", VALIDATION_KEYS, readValidation);
  const incompleteFields = (["changes", "deliverables", "validations"] as const)
    .filter((name) => raw[name] === undefined || lostFields.has(name));
  return {
    summary,
    changes,
    deliverables,
    validations,
    completeness: incompleteFields.length === 0 ? "complete" : "partial",
    missingFields: [...incompleteFields],
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

function stableContent(input: {
  source: OutcomeSnapshotSource;
  sourceEventSeq: number | null;
  sourceOutputSha256: string | null;
  outcome: NormalizedOutcomePayload;
  recoveryNote: string | null;
}): string {
  return JSON.stringify({
    source: input.source,
    sourceEventSeq: input.sourceEventSeq,
    sourceOutputSha256: input.sourceOutputSha256,
    summary: input.outcome.summary,
    changes: input.outcome.changes,
    deliverables: input.outcome.deliverables,
    validations: input.outcome.validations,
    completeness: input.outcome.completeness,
    missingFields: input.outcome.missingFields,
    recoveryNote: input.recoveryNote,
  });
}

function contentHash(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

function parseJsonArray<T>(raw: string, field: string): T[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${field} is not an array`);
  return parsed as T[];
}

function parseRow(row: OutcomeSnapshotRow): OutcomeSnapshot {
  return {
    id: row.id,
    itemId: row.item_id,
    executorRunId: row.executor_run_id,
    completionCheckpointId: row.completion_checkpoint_id,
    source: row.source,
    sourceEventSeq: row.source_event_seq,
    sourceOutputSha256: row.source_output_sha256,
    summary: row.summary,
    changes: parseJsonArray<OutcomeChange>(row.changes_json, "changes_json"),
    deliverables: parseJsonArray<OutcomeDeliverable>(row.deliverables_json, "deliverables_json"),
    validations: parseJsonArray<OutcomeValidation>(row.validations_json, "validations_json"),
    completeness: row.completeness,
    missingFields: parseJsonArray<string>(row.missing_fields_json, "missing_fields_json"),
    recoveryNote: row.recovery_note,
    contentHash: row.content_hash,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

export function getOutcomeSnapshot(db: Db, id: number): OutcomeSnapshot | undefined {
  const row = db.prepare("SELECT * FROM outcome_snapshots WHERE id=?")
    .get(id) as OutcomeSnapshotRow | undefined;
  return row ? parseRow(row) : undefined;
}

export function getOutcomeSnapshotForRun(db: Db, runId: number): OutcomeSnapshot | undefined {
  const row = db.prepare("SELECT * FROM outcome_snapshots WHERE executor_run_id=?")
    .get(runId) as OutcomeSnapshotRow | undefined;
  return row ? parseRow(row) : undefined;
}

export function getLatestOutcomeSnapshot(db: Db, itemId: number): OutcomeSnapshot | undefined {
  const row = db.prepare("SELECT * FROM outcome_snapshots WHERE item_id=? ORDER BY id DESC LIMIT 1")
    .get(itemId) as OutcomeSnapshotRow | undefined;
  return row ? parseRow(row) : undefined;
}

export function countOutcomeSnapshots(db: Db, itemId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM outcome_snapshots WHERE item_id=?")
    .get(itemId) as { n: number }).n;
}

export function insertOutcomeSnapshot(
  db: Db,
  input: InsertOutcomeSnapshotInput,
): InsertOutcomeSnapshotResult {
  const write = (): InsertOutcomeSnapshotResult => {
    const item = db.prepare("SELECT * FROM items WHERE id=?").get(input.itemId) as Item | undefined;
    if (!item) throw new Error(`item #${input.itemId} not found`);
    const run = db.prepare("SELECT * FROM runs WHERE id=?").get(input.executorRunId) as Run | undefined;
    if (!run || run.item_id !== input.itemId) {
      throw new Error(`run #${input.executorRunId} does not belong to item #${input.itemId}`);
    }
    if (run.role !== "executor") throw new Error("outcome snapshots may only be written for executor runs");
    if (input.source === "agent_reported") {
      if (input.completionCheckpointId === null || input.completionCheckpointId === undefined) {
        throw new Error("agent-reported outcome requires a completion checkpoint");
      }
      const checkpoint = db.prepare(
        "SELECT item_id, run_id, kind FROM checkpoints WHERE id=?",
      ).get(input.completionCheckpointId) as {
        item_id: number;
        run_id: number | null;
        kind: string;
      } | undefined;
      if (!checkpoint || checkpoint.item_id !== input.itemId
          || checkpoint.run_id !== input.executorRunId
          || checkpoint.kind !== "completed") {
        throw new Error("completion checkpoint does not match the executor run");
      }
    }
    if (input.source === "system_recovered" && !input.sourceOutputSha256) {
      throw new Error("system-recovered outcome requires a source output hash");
    }
    const sourceEventSeq = input.sourceEventSeq ?? null;
    const sourceOutputSha256 = input.sourceOutputSha256 ?? null;
    const recoveryNote = input.recoveryNote?.trim() || null;
    if (recoveryNote) boundedString(recoveryNote, "recoveryNote", 1_000);
    const idempotencyKey = input.idempotencyKey ?? `outcome:executor-run:${input.executorRunId}`;
    const hash = contentHash(stableContent({
      source: input.source,
      sourceEventSeq,
      sourceOutputSha256,
      outcome: input.outcome,
      recoveryNote,
    }));

    const existing = db.prepare(
      `SELECT * FROM outcome_snapshots
       WHERE idempotency_key=? OR executor_run_id=?
       ORDER BY id LIMIT 1`,
    ).get(idempotencyKey, input.executorRunId) as OutcomeSnapshotRow | undefined;
    if (existing) {
      if (existing.content_hash !== hash || existing.item_id !== input.itemId) {
        throw new Error(`outcome snapshot replay conflict for run #${input.executorRunId}`);
      }
      return { snapshot: parseRow(existing), deduplicated: true };
    }

    const createdAt = (input.now ?? new Date()).toISOString();
    const result = db.prepare(
      `INSERT INTO outcome_snapshots (
         item_id, executor_run_id, completion_checkpoint_id, source, source_event_seq,
         source_output_sha256, summary, changes_json, deliverables_json, validations_json,
         completeness, missing_fields_json, recovery_note, content_hash, idempotency_key, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.itemId,
      input.executorRunId,
      input.completionCheckpointId ?? null,
      input.source,
      sourceEventSeq,
      sourceOutputSha256,
      input.outcome.summary,
      JSON.stringify(input.outcome.changes),
      JSON.stringify(input.outcome.deliverables),
      JSON.stringify(input.outcome.validations),
      input.outcome.completeness,
      JSON.stringify(input.outcome.missingFields),
      recoveryNote,
      hash,
      idempotencyKey,
      createdAt,
    );
    const snapshotId = Number(result.lastInsertRowid);
    // 规范化的诊断和快照一起提交。ticket_update 和成果恢复两条登记路径都经过这里。
    if (input.outcome.diagnostics?.length) {
      addActivity(db, {
        itemId: input.itemId,
        runId: input.executorRunId,
        actor: "system",
        kind: "decision",
        payload: { decision: "outcome_normalized", snapshotId, diagnostics: input.outcome.diagnostics },
      });
    }
    return { snapshot: getOutcomeSnapshot(db, snapshotId)!, deduplicated: false };
  };
  return db.inTransaction ? write() : db.transaction(write).immediate();
}

export function extractOutcomeEnvelope(text: string): { rawJson: string; parsed: unknown } | null {
  let latest: { rawJson: string; parsed: unknown } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf(OUTCOME_SENTINEL);
    if (index === -1) continue;
    const rawJson = line.slice(index + OUTCOME_SENTINEL.length).trim();
    if (!rawJson) continue;
    try {
      latest = { rawJson, parsed: JSON.parse(rawJson) as unknown };
    } catch {
      continue;
    }
  }
  return latest;
}
