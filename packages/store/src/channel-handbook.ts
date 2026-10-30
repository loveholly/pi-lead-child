// 交接说明（自动代你处理方案 B，.scratch/auto-handling-handbook/spec.md）：常设指令 channel.handbook 的读法，和从旧授权表的迁移。
// 形状、缺省内容和做法的比较在 protocol 的 channel-handbook.ts。这里不出现任何具体来源的名字。
import {
  CHANNEL_AUTHORITY_DEFAULTS, CHANNEL_HANDBOOK_DEFAULTS, HANDBOOK_CAP_SENDERS, HANDBOOK_FALLBACK_ID, handbookFromAuthority, handbookModeCovers,
  stableJson, validStandingOrderRuleParams,
  type ChannelHandbook, type ChannelHandbookDto, type HandbookCaps, type HandbookSituation, type StandingOrder, type StandingOrderRef,
} from "@pi-lead-child/protocol";
import { channelAuthorityTable, channelPolicy } from "./channels.js";
import type { Db } from "./db.js";
import { activeStandingOrders, getStandingOrder, listStandingOrderVersions, recordStandingOrderVersion, standingOrderRef } from "./standing-orders.js";

export const CHANNEL_HANDBOOK_ORDER_ID = "channel.handbook";

export interface ChannelHandbookPolicy {
  // 现在生效的：放开的部分在可信的版本里出现过才算数。
  handbook: ChannelHandbook;
  // 最新版本里写的。
  requested: ChannelHandbook;
  order: StandingOrderRef;
}

const isHandbookOrder = (order: StandingOrder) => order.action.type === "rule" && order.action.rule === "channel.handbook"
  && validStandingOrderRuleParams("channel.handbook", order.action.params);
const handbookOf = (order: StandingOrder) => (order.action.type === "rule" ? order.action.params : {}) as unknown as ChannelHandbook;
const isTrusted = (order: StandingOrder) => order.author === "system" || order.author === "user" || Boolean(order.approvedBy);

// 一份可信版本里和 wanted 对应的一句：同一个编号、说法和例句也一样的那一句。说法或例句变了，哪些消息落到这一句也变了，
// 按新加的一句算：和兜底的一句比（不加这一句时，这类消息落到兜底）。
function baseFor(handbook: ChannelHandbook, wanted: HandbookSituation): HandbookSituation {
  const same = handbook.situations.find((situation) => situation.id === wanted.id);
  if (same && same.text === wanted.text && same.example === wanted.example) return same;
  return handbook.situations.find((situation) => situation.id === HANDBOOK_FALLBACK_ID)!;
}

/**
 * 交接说明（常设指令 channel.handbook）。读不到时是 null（调用方用 CHANNEL_HANDBOOK_DEFAULTS）。
 * 放开要你本人改：可信的版本是系统种子、你写的、你批准过的。最新版本里一项比所有可信版本都放开时（例如 Lead 写的放开，
 * 或者被别的办法写进库），这一项按下面的规则收回：
 *   - 一句的做法：可信版本里对应的一句至少一样放开才算数，否则按「交给你」；
 *   - 例外：可信版本里对应的一句有同样说法的例外、并且至少一样放开才算数，否则去掉；
 *   - 能力：只留可信版本里对应的一句也有的；
 *   - 对方的上限：可信版本里至少一样放开才算数，否则按「只告诉你」；
 *   - 总开关：可信版本里开过才算开着。
 */
export function channelHandbook(db: Db): ChannelHandbookPolicy | null {
  const order = activeStandingOrders(db).find((candidate) => candidate.id === CHANNEL_HANDBOOK_ORDER_ID && isHandbookOrder(candidate));
  if (!order) return null;
  const requested = handbookOf(order);
  const trusted = [order, ...listStandingOrderVersions(db, order.id)].filter((version) => isHandbookOrder(version) && isTrusted(version))
    .map(handbookOf);
  const situations = requested.situations.map((wanted): HandbookSituation => {
    const bases = trusted.map((handbook) => baseFor(handbook, wanted));
    const mode = bases.some((base) => handbookModeCovers(base.mode, wanted.mode)) ? wanted.mode : "hand";
    const abilities = wanted.abilities.filter((ability) => bases.some((base) => base.abilities.includes(ability)));
    const exceptionOk = wanted.exception !== undefined && bases.some((base) => base.exception?.text === wanted.exception!.text
      && handbookModeCovers(base.exception.mode, wanted.exception!.mode));
    const { exception, ...rest } = wanted;
    return { ...rest, mode, abilities, ...(exception && exceptionOk ? { exception } : {}) };
  });
  const caps = Object.fromEntries(HANDBOOK_CAP_SENDERS.map((sender) => [sender,
    trusted.some((handbook) => handbookModeCovers(handbook.caps[sender], requested.caps[sender])) ? requested.caps[sender] : "tell",
  ])) as HandbookCaps;
  const autoReply = requested.autoReply && trusted.some((handbook) => handbook.autoReply);
  return { handbook: { autoReply, situations, caps }, requested, order: standingOrderRef(order) };
}

/** 设置页读的交接说明（issue 07）：现在生效的、最新版本里写的、缺省的，和存在哪一版、谁写的。 */
export function channelHandbookDto(db: Db): ChannelHandbookDto {
  const policy = channelHandbook(db);
  if (!policy) return { handbook: CHANNEL_HANDBOOK_DEFAULTS, requested: CHANNEL_HANDBOOK_DEFAULTS, defaults: CHANNEL_HANDBOOK_DEFAULTS, order: null };
  const order = getStandingOrder(db, policy.order.id, policy.order.version);
  return {
    handbook: policy.handbook, requested: policy.requested, defaults: CHANNEL_HANDBOOK_DEFAULTS,
    order: { id: policy.order.id, version: policy.order.version, author: order?.author ?? "system" },
  };
}

/**
 * 从旧授权表迁移（spec「迁移」）：旧授权表（通用的一条，source "*"）里你改过的项搬到交接说明上，写成你的一个版本。
 * openDb 在同步系统种子以后调用。幂等，最多写一个版本：
 *   - 交接说明已经有不是系统写的版本（你改过，或者已经迁移过）：不动；
 *   - 旧授权表和它的开关都是缺省的：搬过来和缺省一样，不写；
 *   - 只用现在生效的旧授权表（没有批准过的放开已经按「问你」算），所以写成你的版本不会多放开什么。
 */
export function migrateAuthorityToHandbook(db: Db, at: Date = new Date()): StandingOrder | null {
  return db.transaction(() => {
    const versions = listStandingOrderVersions(db, CHANNEL_HANDBOOK_ORDER_ID);
    if (!versions.length || versions.some((version) => version.author !== "system")) return null;
    const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
    if (!isHandbookOrder(latest) || latest.status !== "active") return null;
    const authority = channelAuthorityTable(db, "*");
    if (!authority) return null;
    const autoReply = channelPolicy(db, "*")?.params.autoReply ?? CHANNEL_HANDBOOK_DEFAULTS.autoReply;
    const current = handbookOf(latest);
    const migrated = handbookFromAuthority(authority.table, CHANNEL_AUTHORITY_DEFAULTS, autoReply, current);
    if (stableJson(migrated) === stableJson(current)) return null;
    const { version: _version, author: _author, approvedBy: _approvedBy, status: _status, createdAt: _createdAt, seedRevision: _seed, ...definition } = latest;
    return recordStandingOrderVersion(db, {
      ...definition,
      action: { type: "rule", rule: "channel.handbook", params: migrated as unknown as Record<string, unknown> },
      reason: `从旧授权表（${authority.order.id} 第 ${authority.order.version} 版）迁移：保留你改过的项，其余用交接说明的缺省`,
    }, { author: "user", at });
  }).immediate();
}
