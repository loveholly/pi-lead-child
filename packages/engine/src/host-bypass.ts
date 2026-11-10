// 「用户本人发话时免沙箱」开关（docs/ticket-246-user-turn-bypass.md 第 5 节，实施单 A）：开和关。
// 开和关的入口是操作层的 host_bypass（ui-actions/host-bypass.ts）：设置页和 Lead 的 perform_action 调同一个定义，权限在那里判断。
// 开关没有时限（用户 2026-11-10）：打开以后一直开着，直到用户或 Lead 关掉。没有到点的定时器，也不再写 host_bypass.expired。
// 每一次开、关：写 kv，同一笔事务里写一条事件（5.5），然后发 snapshot.required 让界面刷新，再写一条 inbox 告诉 Lead。
import {
  DEFAULT_HOST_BYPASS, HOST_BYPASS_DISABLED_KIND, HOST_BYPASS_ENABLED_KIND, HOST_BYPASS_ENTITY_KEY, HOST_BYPASS_RESOURCE,
  type HostBypassDisabledBy, type HostBypassDto,
} from "@pi-lead-child/protocol";
import {
  addInbox, appendEvent, getHostBypass, hostBypassOn, publishGatewayEvent, readStoredHostBypass, writeHostBypass, type Db,
} from "@pi-lead-child/store";

// 用户自己去哪里打开。Lead 调 enable 被拒时，拒绝里写它。
export const HOST_BYPASS_WHERE = "设置 → 免沙箱（用户本人发话时免沙箱）";

export interface HostBypassChange {
  hostBypass: HostBypassDto;
  // 这次有没有改：开着时再开一次、关着时再关一次都不算。
  changed: boolean;
}

function announce(db: Db, summary: string, state: "enabled" | "disabled", wakeLead: boolean): void {
  publishGatewayEvent(db, { type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: HOST_BYPASS_RESOURCE } });
  addInbox(db, {
    dedupScope: HOST_BYPASS_ENTITY_KEY, severity: "attention", source: "structural", lossless: true, summary,
    payload: { kind: "host_bypass", state, wakeLead, needsUser: false },
  });
}

/**
 * 打开免沙箱。授权已经由操作层做过。已经开着时什么也不写（changed=false）。
 * 旧版本写的、还没到 until 的行算开着，但这次照样重写成没有 until 的行：用户在设置页又点了一次打开。
 */
export function enableHostBypass(db: Db, input: {
  bindingId: number | null; resolvedBy: string; reason: string; now: Date;
}): HostBypassChange {
  const enabledAt = input.now.toISOString();
  const changed = db.transaction((): boolean => {
    const stored = readStoredHostBypass(db);
    if (hostBypassOn(stored, input.now) && stored.until === null) return false;
    writeHostBypass(db, { enabled: true, bindingId: input.bindingId, enabledAt, reason: input.reason });
    appendEvent(db, {
      source: "system", kind: HOST_BYPASS_ENABLED_KIND, entityKey: HOST_BYPASS_ENTITY_KEY, level: "record",
      payload: { bindingId: input.bindingId, resolvedBy: input.resolvedBy },
      occurredAt: enabledAt,
    });
    return true;
  })();
  if (changed) announce(db, "用户在设置页打开了「用户本人发话时免沙箱」。它一直开着，直到用户或你关掉。", "enabled", true);
  return { hostBypass: getHostBypass(db, input.now), changed };
}

/**
 * 关掉免沙箱。已经关着时什么也不写（changed=false），包括旧版本写的、已经过了 until 的行。
 * Lead 自己关的不叫醒 Lead：它从工具结果里已经知道了。
 */
export function disableHostBypass(db: Db, input: {
  by: HostBypassDisabledBy; turnId: string | null; reason: string; now: Date;
}): HostBypassChange {
  const changed = db.transaction((): boolean => {
    if (!hostBypassOn(readStoredHostBypass(db), input.now)) return false;
    writeHostBypass(db, { ...DEFAULT_HOST_BYPASS, enabled: false, reason: input.reason });
    appendEvent(db, {
      source: "system", kind: HOST_BYPASS_DISABLED_KIND, entityKey: HOST_BYPASS_ENTITY_KEY, level: "record",
      payload: { by: input.by, turnId: input.turnId, reason: input.reason },
      occurredAt: input.now.toISOString(),
    });
    return true;
  })();
  if (changed) {
    announce(
      db,
      input.by === "user" ? "用户关掉了「用户本人发话时免沙箱」。" : "你关掉了「用户本人发话时免沙箱」。",
      "disabled", input.by === "user",
    );
  }
  return { hostBypass: getHostBypass(db, input.now), changed };
}
