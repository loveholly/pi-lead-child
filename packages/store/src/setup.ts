// 首次启动引导（2026-10-30，.scratch/onboarding/spec.md）的小状态，都存在 kv 里：
//   - setup.status：7 项关键设置配没配好（daemon 算，网关和 Lead 读）。只重算、没变化时不写。
//   - setup.checklist：准备清单卡建了没有、什么时候建的；功能上线前就能用大脑的老用户记成 skipped，不补发。
//   - setup.hints：每轮结束时的建议卡：发过的卡、每项最近一次提的时间、「以后再说」到什么时候、「不用再提」。
import {
  SETUP_HINT_ANY_COOLDOWN_MS, SETUP_HINT_ITEM_COOLDOWN_MS, SETUP_ITEM_KEYS,
  type SetupHintState, type SetupItem, type SetupItemKey, type SetupStatus,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

const STATUS_KEY = "setup.status";
const CHECKLIST_KEY = "setup.checklist";
const HINTS_KEY = "setup.hints";
// 留多少张建议卡（会话里能看到的最近几张）。
const HINT_CARDS_KEPT = 20;

function readJson(db: Db, key: string): unknown {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

function writeJson(db: Db, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isItemKey = (value: unknown): value is SetupItemKey =>
  typeof value === "string" && (SETUP_ITEM_KEYS as readonly string[]).includes(value);

// ── 设置状态 ───────────────────────────────────────────────────────────────────────

export function loadSetupStatus(db: Db): SetupStatus | null {
  const raw = readJson(db, STATUS_KEY);
  if (!isRecord(raw) || !Array.isArray(raw.items) || typeof raw.changedAt !== "string") return null;
  const items: SetupItem[] = [];
  for (const item of raw.items) {
    if (!isRecord(item) || !isItemKey(item.key) || typeof item.ready !== "boolean") continue;
    items.push({ key: item.key, ready: item.ready, detail: typeof item.detail === "string" ? item.detail : null });
  }
  return { items, changedAt: raw.changedAt };
}

/** 存一次重算的结果。和存着的一样时不写，changedAt 不动。返回存着的状态和这次有没有变。 */
export function saveSetupStatus(db: Db, items: SetupItem[], now = new Date()): { status: SetupStatus; changed: boolean } {
  const previous = loadSetupStatus(db);
  const ordered = SETUP_ITEM_KEYS.flatMap((key) => items.filter((item) => item.key === key).slice(0, 1))
    .map((item) => ({ key: item.key, ready: item.ready, detail: item.detail }));
  if (previous && JSON.stringify(previous.items) === JSON.stringify(ordered)) return { status: previous, changed: false };
  const status = { items: ordered, changedAt: now.toISOString() };
  writeJson(db, STATUS_KEY, status);
  return { status, changed: true };
}

// ── 准备清单卡 ─────────────────────────────────────────────────────────────────────

export interface SetupChecklistRecord {
  // shown：建了卡；skipped：功能上线前大脑就能用，不补发。
  state: "shown" | "skipped";
  at: string;
}

export function loadSetupChecklist(db: Db): SetupChecklistRecord | null {
  const raw = readJson(db, CHECKLIST_KEY);
  if (!isRecord(raw) || (raw.state !== "shown" && raw.state !== "skipped") || typeof raw.at !== "string") return null;
  return { state: raw.state, at: raw.at };
}

/** 只记第一次：已经有记录时不改，返回原来的记录。 */
export function recordSetupChecklist(db: Db, state: SetupChecklistRecord["state"], now = new Date()): SetupChecklistRecord {
  return db.transaction(() => {
    const existing = loadSetupChecklist(db);
    if (existing) return existing;
    const record = { state, at: now.toISOString() };
    writeJson(db, CHECKLIST_KEY, record);
    return record;
  })();
}

// ── 建议卡 ─────────────────────────────────────────────────────────────────────────

export interface SetupHintRecord {
  id: number;
  item: SetupItemKey;
  // 卡的位置：那一轮结束的时间。
  at: string;
  // 用户的处理：open（还没处理）、snoozed（以后再说）、dismissed（不用再提）。配好了没有由设置状态现算。
  state: Exclude<SetupHintState, "ready">;
  updatedAt: string;
}

interface SetupHintItemRecord {
  lastAt: string;
  snoozedUntil: string | null;
  never: boolean;
}

export interface SetupHintsState {
  nextId: number;
  cards: SetupHintRecord[];
  items: Partial<Record<SetupItemKey, SetupHintItemRecord>>;
}

export function loadSetupHints(db: Db): SetupHintsState {
  const raw = readJson(db, HINTS_KEY);
  const state: SetupHintsState = { nextId: 1, cards: [], items: {} };
  if (!isRecord(raw)) return state;
  if (typeof raw.nextId === "number" && Number.isSafeInteger(raw.nextId) && raw.nextId >= 1) state.nextId = raw.nextId;
  if (Array.isArray(raw.cards)) {
    for (const card of raw.cards) {
      if (!isRecord(card) || typeof card.id !== "number" || !isItemKey(card.item) || typeof card.at !== "string") continue;
      const cardState = card.state === "snoozed" || card.state === "dismissed" ? card.state : "open";
      state.cards.push({ id: card.id, item: card.item, at: card.at, state: cardState, updatedAt: typeof card.updatedAt === "string" ? card.updatedAt : card.at });
    }
  }
  if (isRecord(raw.items)) {
    for (const [key, value] of Object.entries(raw.items)) {
      if (!isItemKey(key) || !isRecord(value) || typeof value.lastAt !== "string") continue;
      state.items[key] = {
        lastAt: value.lastAt,
        snoozedUntil: typeof value.snoozedUntil === "string" ? value.snoozedUntil : null,
        never: value.never === true,
      };
    }
  }
  return state;
}

/**
 * 这一轮结束时该提哪一项（spec R3、R4）：按清单顺序，第一项没配好、没说过「不用再提」、不在冷却里的。
 * 任何一项两天内提过，这一轮都不提。
 */
export function pickSetupHint(status: SetupStatus, hints: SetupHintsState, now = new Date()): SetupItemKey | null {
  const nowMs = now.getTime();
  const lastAny = Math.max(0, ...Object.values(hints.items).map((item) => Date.parse(item!.lastAt) || 0));
  if (nowMs - lastAny < SETUP_HINT_ANY_COOLDOWN_MS) return null;
  for (const key of SETUP_ITEM_KEYS) {
    const item = status.items.find((candidate) => candidate.key === key);
    // 大脑没配好时这一轮根本跑不起来；首次启动页管它。
    if (!item || item.ready || key === "brain") continue;
    const record = hints.items[key];
    if (record?.never) continue;
    if (record && nowMs - (Date.parse(record.lastAt) || 0) < SETUP_HINT_ITEM_COOLDOWN_MS) continue;
    if (record?.snoozedUntil && nowMs < Date.parse(record.snoozedUntil)) continue;
    return key;
  }
  return null;
}

/** 发一张建议卡：记下这一项提过的时间。 */
export function recordSetupHint(db: Db, item: SetupItemKey, now = new Date()): SetupHintRecord {
  return db.transaction(() => {
    const state = loadSetupHints(db);
    const at = now.toISOString();
    const card: SetupHintRecord = { id: state.nextId, item, at, state: "open", updatedAt: at };
    state.nextId += 1;
    state.cards = [...state.cards, card].slice(-HINT_CARDS_KEPT);
    state.items[item] = { lastAt: at, snoozedUntil: state.items[item]?.snoozedUntil ?? null, never: false };
    writeJson(db, HINTS_KEY, state);
    return card;
  })();
}

export function getSetupHint(db: Db, id: number): SetupHintRecord | null {
  return loadSetupHints(db).cards.find((card) => card.id === id) ?? null;
}

/** 以后再说（snoozed：这一项 7 天内不再提）或者不用再提（dismissed：这一项以后都不提）。 */
export function resolveSetupHint(db: Db, id: number, choice: "snoozed" | "dismissed", now = new Date()): SetupHintRecord | null {
  return db.transaction(() => {
    const state = loadSetupHints(db);
    const card = state.cards.find((candidate) => candidate.id === id);
    if (!card) return null;
    const at = now.toISOString();
    card.state = choice;
    card.updatedAt = at;
    const previous = state.items[card.item] ?? { lastAt: card.at, snoozedUntil: null, never: false };
    state.items[card.item] = choice === "dismissed"
      ? { ...previous, never: true }
      : { ...previous, snoozedUntil: new Date(now.getTime() + SETUP_HINT_ITEM_COOLDOWN_MS).toISOString() };
    writeJson(db, HINTS_KEY, state);
    return card;
  })();
}
