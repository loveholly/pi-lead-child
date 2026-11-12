// External agenda feeds: a generic way to mirror an outside calendar (or any dated list) into the system agenda.
//
// A feed is data, not code: no calendar platform gets its own logic.
//   - A signal source with `agendaFeed` hands its script's `agenda` output to the feed on every run, or Lead submits a
//     snapshot through the `agenda_feed.sync` action. Only Lead may submit snapshots; executors cannot.
//   - The store keeps one row per entry (`agenda_entries`), keyed by (feed, key). A complete snapshot also marks entries
//     that disappeared inside the sync window as removed.
//   - After every sync the store reconciles reminders: each entry that wants one gets a pre-created reminder item
//     (`created_by=system`) at "start − N minutes". Moves, cancellations and removals move or cancel it. A user's own
//     reschedule keeps its offset; a user's cancel mutes the entry.
//   - Entry titles are written by other people (meeting organisers). They are external content.
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { registerEventKind, registerExternalEventSource } from "./events.ts";

const StrictObject = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** Event source of feed change events. External: entry words come from other people. */
export const AGENDA_EVENT_SOURCE = "agenda";
export const AGENDA_CHANGED_KIND = "agenda.changed";

export const AGENDA_FEED_NAME_PATTERN = "^[a-z][a-z0-9-]{1,39}$";
const TIME_OF_DAY_PATTERN = "^([01][0-9]|2[0-3]):[0-5][0-9]$";

export const AGENDA_FEED_LIMITS = {
  label: 80,
  maxPastHours: 7 * 24,
  maxFutureDays: 120,
  maxMinutesBefore: 24 * 60,
  // One snapshot holds at most this many entries; extra ones are rejected, not truncated silently.
  maxEntries: 500,
  key: 200,
  title: 300,
  location: 300,
  url: 2_000,
  // Feed change events only cover entries that start within this many hours.
  changeHorizonHours: 24,
} as const;

/** Defaults the user chose (2026-11-12): five minutes before, important. */
export const AGENDA_FEED_DEFAULTS = {
  pastHours: 12,
  futureDays: 14,
  minutesBefore: 5,
  level: "interrupt",
  statuses: ["confirmed"],
  allDayAt: null,
} as const;

export const AGENDA_ENTRY_STATUSES = ["confirmed", "tentative", "cancelled"] as const;
export type AgendaEntryStatus = typeof AGENDA_ENTRY_STATUSES[number];
const AgendaEntryStatusSchema = Type.Union([Type.Literal("confirmed"), Type.Literal("tentative"), Type.Literal("cancelled")]);
const ReminderLevelSchema = Type.Union([Type.Literal("interrupt"), Type.Literal("tell")]);
const RemindableStatusSchema = Type.Union([Type.Literal("confirmed"), Type.Literal("tentative")]);

export const AgendaFeedWindowSchema = StrictObject({
  pastHours: Type.Integer({ minimum: 0, maximum: AGENDA_FEED_LIMITS.maxPastHours }),
  futureDays: Type.Integer({ minimum: 1, maximum: AGENDA_FEED_LIMITS.maxFutureDays }),
});
export type AgendaFeedWindow = Static<typeof AgendaFeedWindowSchema>;

export const AgendaFeedRemindSchema = StrictObject({
  enabled: Type.Boolean(),
  minutesBefore: Type.Integer({ minimum: 0, maximum: AGENDA_FEED_LIMITS.maxMinutesBefore }),
  level: ReminderLevelSchema,
  // Which entry statuses get a reminder.
  statuses: Type.Array(RemindableStatusSchema, { minItems: 1, maxItems: 2, uniqueItems: true }),
  // All-day entries: remind at this local time of that day. null: no reminder for all-day entries.
  allDayAt: Nullable(Type.String({ pattern: TIME_OF_DAY_PATTERN })),
});
export type AgendaFeedRemind = Static<typeof AgendaFeedRemindSchema>;

/** Creating a feed. Omitted fields take AGENDA_FEED_DEFAULTS. */
export const AgendaFeedInputSchema = StrictObject({
  name: Type.String({ pattern: AGENDA_FEED_NAME_PATTERN }),
  label: Type.String({ minLength: 1, maxLength: AGENDA_FEED_LIMITS.label }),
  window: Type.Optional(Type.Partial(AgendaFeedWindowSchema)),
  remind: Type.Optional(Type.Partial(AgendaFeedRemindSchema)),
});
export type AgendaFeedInput = Static<typeof AgendaFeedInputSchema>;

/** Changing a feed: at least one field. `remind` and `window` merge into the current values. */
export const AgendaFeedUpdateSchema = Type.Object({
  label: Type.Optional(AgendaFeedInputSchema.properties.label),
  window: Type.Optional(Type.Partial(AgendaFeedWindowSchema)),
  remind: Type.Optional(Type.Partial(AgendaFeedRemindSchema)),
}, { additionalProperties: false, minProperties: 1 });
export type AgendaFeedUpdate = Static<typeof AgendaFeedUpdateSchema>;

/** One entry as a source reports it. A signal source script and Lead's snapshot use the same shape. */
export const AgendaEntryInputSchema = StrictObject({
  // The source's own id. For recurring events use the instance id: the system does not expand recurrence rules.
  key: Type.String({ minLength: 1, maxLength: AGENDA_FEED_LIMITS.key }),
  title: Type.String({ minLength: 1, maxLength: AGENDA_FEED_LIMITS.title }),
  // ISO time with an offset, or a bare date (YYYY-MM-DD) for an all-day entry.
  startsAt: Type.String({ minLength: 10, maxLength: 64 }),
  endsAt: Type.Optional(Type.String({ minLength: 10, maxLength: 64 })),
  allDay: Type.Optional(Type.Boolean()),
  status: Type.Optional(AgendaEntryStatusSchema),
  location: Type.Optional(Type.String({ maxLength: AGENDA_FEED_LIMITS.location })),
  url: Type.Optional(Type.String({ maxLength: AGENDA_FEED_LIMITS.url })),
  // The source's per-entry exception, for example skip a declined meeting.
  remind: Type.Optional(StrictObject({
    skip: Type.Optional(Type.Boolean()),
    minutesBefore: Type.Optional(Type.Integer({ minimum: 0, maximum: AGENDA_FEED_LIMITS.maxMinutesBefore })),
  })),
});
export type AgendaEntryInput = Static<typeof AgendaEntryInputSchema>;

/** A snapshot of the feed's sync window. complete=false: the source may have left entries out, so nothing is removed. */
export const AgendaSnapshotSchema = StrictObject({
  entries: Type.Array(Type.Unknown(), { maxItems: AGENDA_FEED_LIMITS.maxEntries }),
  complete: Type.Optional(Type.Boolean()),
});
export type AgendaSnapshot = { entries: unknown[]; complete?: boolean };

/** The user's own per-entry setting. minutesBefore null goes back to the source or feed default. */
export const AgendaEntryPatchSchema = Type.Object({
  muted: Type.Optional(Type.Boolean()),
  minutesBefore: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: AGENDA_FEED_LIMITS.maxMinutesBefore }))),
}, { additionalProperties: false, minProperties: 1 });
export type AgendaEntryPatch = Static<typeof AgendaEntryPatchSchema>;

export interface AgendaFeedDto {
  name: string;
  label: string;
  window: AgendaFeedWindow;
  remind: AgendaFeedRemind;
  enabled: boolean;
  createdBy: "user" | "lead";
  createdAt: string;
  updatedAt: string;
  lastSyncAt: string | null;
  lastSyncStatus: "ok" | "error" | null;
  lastError: string | null;
  // First successful sync. Changes before it are the baseline and raise no event.
  baselinedAt: string | null;
}

export interface AgendaEntryDto {
  id: number;
  feed: string;
  key: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  status: AgendaEntryStatus;
  location: string | null;
  url: string | null;
  sourceSkip: boolean;
  sourceMinutesBefore: number | null;
  muted: boolean;
  minutesBefore: number | null;
  reminderItemId: number | null;
  reminderPlannedAt: string | null;
  firstSeenAt: string;
  updatedAt: string;
  removedAt: string | null;
}

/** What one sync did. Counts only: entry words never go into this result. */
export interface AgendaSyncResult {
  feed: string;
  received: number;
  rejected: number;
  inserted: number;
  updated: number;
  removed: number;
  reminders: { created: number; moved: number; cancelled: number; muted: number };
  baseline: boolean;
  changedEvent: number | null;
}

export function defaultAgendaFeedWindow(): AgendaFeedWindow {
  return { pastHours: AGENDA_FEED_DEFAULTS.pastHours, futureDays: AGENDA_FEED_DEFAULTS.futureDays };
}

export function defaultAgendaFeedRemind(): AgendaFeedRemind {
  return {
    enabled: true, minutesBefore: AGENDA_FEED_DEFAULTS.minutesBefore, level: AGENDA_FEED_DEFAULTS.level,
    statuses: [...AGENDA_FEED_DEFAULTS.statuses], allDayAt: AGENDA_FEED_DEFAULTS.allDayAt,
  };
}

registerExternalEventSource(AGENDA_EVENT_SOURCE);
registerEventKind({
  kind: AGENDA_CHANGED_KIND,
  sources: [AGENDA_EVENT_SOURCE],
  payload: Type.Object({
    feed: Type.String({ minLength: 1 }),
    label: Type.String(),
    moved: Type.Integer({ minimum: 0 }),
    cancelled: Type.Integer({ minimum: 0 }),
    removed: Type.Integer({ minimum: 0 }),
    entryIds: Type.Array(Type.Integer({ minimum: 1 })),
    summary: Type.String(),
  }),
  description: "An agenda feed sync changed entries that start soon and carry (or carried) a reminder: moved, cancelled or removed. Counts only; read the entries with read_agenda_entries.",
});

/** A checked entry with normalised times (ISO, UTC). All-day bare dates become local midnight. */
export interface NormalizedAgendaEntry {
  key: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  status: AgendaEntryStatus;
  location: string | null;
  url: string | null;
  sourceSkip: boolean;
  sourceMinutesBefore: number | null;
}

const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse an ISO time or a bare date. A bare date is local midnight of that day (the daemon's time zone). */
export function parseAgendaTime(value: string): { at: Date; dateOnly: boolean } | null {
  const bare = BARE_DATE.exec(value);
  if (bare) {
    const at = new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]));
    return Number.isNaN(at.getTime()) ? null : { at, dateOnly: true };
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { at: new Date(ms), dateOnly: false } : null;
}

/** Check one entry from a source. Returns the reason in English when it does not fit. */
export function normalizeAgendaEntry(value: unknown): { ok: true; entry: NormalizedAgendaEntry } | { ok: false; error: string } {
  if (!Value.Check(AgendaEntryInputSchema, value)) {
    const first = [...Value.Errors(AgendaEntryInputSchema, value)][0];
    return { ok: false, error: first ? `${first.instancePath || "/"} ${first.message}` : "not an agenda entry" };
  }
  const input = value as AgendaEntryInput;
  const start = parseAgendaTime(input.startsAt);
  if (!start) return { ok: false, error: "/startsAt is not a time" };
  const end = input.endsAt === undefined ? null : parseAgendaTime(input.endsAt);
  if (input.endsAt !== undefined && !end) return { ok: false, error: "/endsAt is not a time" };
  if (end && end.at.getTime() < start.at.getTime()) return { ok: false, error: "/endsAt is before startsAt" };
  if (input.url !== undefined && !/^https:\/\//i.test(input.url)) return { ok: false, error: "/url must start with https://" };
  const title = input.title.trim();
  if (!title) return { ok: false, error: "/title is empty" };
  return {
    ok: true,
    entry: {
      key: input.key,
      title,
      startsAt: start.at.toISOString(),
      endsAt: end ? end.at.toISOString() : null,
      allDay: input.allDay ?? start.dateOnly,
      status: input.status ?? "confirmed",
      location: input.location?.trim() ? input.location.trim() : null,
      url: input.url ?? null,
      sourceSkip: input.remind?.skip === true,
      sourceMinutesBefore: input.remind?.minutesBefore ?? null,
    },
  };
}
