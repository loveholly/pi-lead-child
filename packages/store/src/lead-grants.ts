// 用户对 lead 的授权（可撤销、可持久、可审计）。
//
// 用户的原话是「如果我授权了，我的 lead agent 应该有权限做所有的操作」——这句话是对的，
// 拒绝一切授权才是错的。但把 confirm_item 直接塞进 lead 的工具表，等于把"建完先别跑"
// 退回成提示词自律，而 items.ts / stages.ts 存在的全部理由就是消灭那种自律
// （见 git log「不依赖提示词自律」）。
//
// 所以授权本身必须是一个 **lead 伪造不了的事实**：它只能从 CLI 或控制面进来（两者都是
// 用户本人在按键），落进 lead_grants 表，随时可撤。lead 能读到这个事实（工具在不在），
// 但没有任何一条工具能改写它。
//
// 权限矩阵一个字不动：draft→ready 仍然只属于 user。带授权的 lead 确认，落笔仍是
// actor='user'——那不是冒名，那是 lead 代用户行使用户**已经给出**的、随时可收回的授权，
// 并且每一次都在活动流里指名是哪一次授权（见 lead/tools.ts 的 confirm_item）。
import type { Db } from "./db.js";

// 枚举而不是布尔：授权的是一项**能力**，不是一个"信任 lead"的开关。
// 想扩到别的动作要改 CHECK + 迁移 + 测试，而不是改一行配置——这是刻意的摩擦。
export type LeadCapability = "confirm_item";
export type LeadGrantChannel = "cli" | "control-plane";

export interface LeadGrant {
  id: number;
  capability: LeadCapability;
  granted_at: string;
  granted_via: LeadGrantChannel;
  revoked_at: string | null;
  revoked_via: LeadGrantChannel | null;
  note: string | null;
}

export function activeLeadGrant(db: Db, capability: LeadCapability): LeadGrant | null {
  return (db.prepare(
    `SELECT * FROM lead_grants
     WHERE capability = ? AND revoked_at IS NULL
     ORDER BY id DESC LIMIT 1`,
  ).get(capability) as LeadGrant | undefined) ?? null;
}

export function leadHasCapability(db: Db, capability: LeadCapability): boolean {
  return activeLeadGrant(db, capability) !== null;
}

// 幂等：已经授权过就返回同一行，而不是堆出第二条同时生效的授权——两条生效的授权会让
// "凭哪一次"这个问题没有唯一答案，而那正是这张表存在的理由。
export function grantLeadCapability(
  db: Db,
  args: { capability: LeadCapability; via: LeadGrantChannel; note?: string },
): LeadGrant {
  return db.transaction(() => {
    const existing = activeLeadGrant(db, args.capability);
    if (existing) return existing;
    const r = db.prepare(
      "INSERT INTO lead_grants (capability, granted_via, note) VALUES (?, ?, ?)",
    ).run(args.capability, args.via, args.note ?? null);
    return db.prepare("SELECT * FROM lead_grants WHERE id = ?")
      .get(Number(r.lastInsertRowid)) as LeadGrant;
  })();
}

// 撤销不删行：撤销之后仍然要答得出"当时授权的是什么、哪些确认是凭它做的"。
// 返回被撤销的条数（0 表示本来就没有生效的授权，这是幂等的成功，不是错误）。
export function revokeLeadCapability(
  db: Db,
  args: { capability: LeadCapability; via: LeadGrantChannel },
): number {
  return db.prepare(
    `UPDATE lead_grants SET revoked_at = datetime('now'), revoked_via = ?
     WHERE capability = ? AND revoked_at IS NULL`,
  ).run(args.via, args.capability).changes;
}

export function listLeadGrants(db: Db, capability?: LeadCapability): LeadGrant[] {
  return (capability
    ? db.prepare("SELECT * FROM lead_grants WHERE capability = ? ORDER BY id DESC").all(capability)
    : db.prepare("SELECT * FROM lead_grants ORDER BY id DESC").all()) as LeadGrant[];
}

// 活动流与错误信息里指名授权的统一写法：只有 id + 授权时刻，不含任何自由文本，
// 这样"为什么这条会跑起来"在日后是可核对的，而不是一句"lead 说用户同意了"。
export function leadGrantAuthorityLabel(grant: LeadGrant): string {
  return `user grant #${grant.id} (${grant.capability}, granted ${grant.granted_at} via ${grant.granted_via})`;
}
