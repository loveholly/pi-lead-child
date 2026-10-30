// 工单操作的定义（spec 5.11）。每个操作只定义一次：id 和输入（protocol 的 TICKET_ACTION_INPUT_SCHEMAS）、谁能做、
// 是否对外、是否不可逆、能不能撤销、现在能不能做（available）、真正执行（run）。页面（HTTP）和 Lead（工具）都经过
// index.ts 的 runTicketAction，所以两个入口做同样的检查，记同样的账本，只是 actor 不同。
import type { Item } from "@pi-lead-child/core";
import type {
  OwnerActionId, OwnerActionSource, Scope, TicketActionArea, TicketActionId, TicketActionInputs, TicketActionPermission,
} from "@pi-lead-child/protocol";
import type { Binding, Db, OwnerActionInput } from "@pi-lead-child/store";
import type { PullRequestRunner, TicketDelivery } from "../coordinator/delivery.js";
import type { ActionAttribution } from "./attribution.js";
import type { TicketActionHost } from "./lifecycle.js";

export type OwnerCredential = Pick<Binding, "id" | "kind" | "display_name" | "origin">;

// 谁在调用。页面：你本人，网关带上发出请求的凭证和来源（记主人操作用）。Lead：带上当前这一轮的 id，
// 只属于你的操作要凭它（store 的 activePairedUserTurn），Lead 改不了它。
export type TicketActionCaller =
  | { kind: "user"; credential?: OwnerCredential | null; source?: OwnerActionSource | null }
  // externalTurn：这一轮读过外部内容（Lead 的 turnOrigin().external）。原来要用户这一轮的操作这时做不了（authority.ts）。
  | { kind: "lead"; turnId: string | null; externalTurn?: boolean };

export interface Availability {
  available: boolean;
  // 不能做的原因，用户能看懂的一句话。能做时为 null。
  reason: string | null;
}

export const AVAILABLE: Availability = Object.freeze({ available: true, reason: null });
export const unavailable = (reason: string): Availability => ({ available: false, reason });

// available 和 run 共用的查询。delivery 要读 git，一次请求里只读一次。
export interface TicketActionEnv {
  db: Db;
  host: TicketActionHost;
  now: Date;
  delivery(): Promise<TicketDelivery>;
  liveItemIds(): number[];
  pullRequestRunner?: PullRequestRunner;
  // 请求来自这台电脑：页面的请求从回环地址来（网关看 socket），Lead 是本机的 daemon。只在本机生效的操作（打开文件）看它。
  local: boolean;
}

// 这一次是凭什么做的：
//   user       你本人（页面）。
//   on_behalf  Lead 在你这一轮里代你做（只属于你的、对外的、不可逆的操作）。
//   lead       Lead 自己的权限（lead_allowed）。
//   delegated  Lead 按托管授权自己做（delegated，且在托管范围内，例如核查员给了 PASS）。
export type TicketActionAuthority = "user" | "on_behalf" | "lead" | "delegated";

export interface TicketActionRun<I> {
  db: Db;
  env: TicketActionEnv;
  // 操作之前的工单。
  item: Item;
  input: I;
  // 为什么做：你给的，或者这个操作的默认说法；Lead 必须给。
  reason: string;
  // 你给了 reason 时为 true。有的操作只在你写了原因时才把它写进账本（否则用和以前一样的默认话）。
  reasonGiven: boolean;
  by: ActionAttribution;
  authority: TicketActionAuthority;
  // Lead 调用时的当前轮次（出处用，例如截止节点记在哪一轮）；你本人调用时为 null。它不是授权：授权在 by.onBehalfOf。
  turnId: string | null;
  // 这次凭的配对凭证：页面入口是发出请求的凭证，Lead 代你做时是那一轮来自的凭证，Lead 自己做时为 null。
  bindingId: number | null;
}

export interface TicketActionEffects {
  // 要通知客户端刷新的工单（ticket.updated）。不给时是这张工单。
  itemIds?: number[];
  // 要通知客户端刷新的 Run（attempt.updated）。给了就只发 Run 的事件。
  runs?: Array<{ itemId: number; runId: number }>;
}

export interface TicketActionDefinition<K extends TicketActionId = TicketActionId> {
  id: K;
  label: string;
  area: TicketActionArea;
  // 页面入口要的 scope。
  scope: Scope;
  // 谁能做。多数是固定的；有的按工单现在的状态算（例如取消：待验收的工单只属于你），那时 permissionNote 写给 Lead 看。
  permission: TicketActionPermission | ((item: Item) => TicketActionPermission);
  permissionNote?: string;
  // 只对 delegated：不在托管或长期授权范围内时，告诉 Lead 为什么（缺省说「工单没有托管给你」）。
  delegatedWhy?: string;
  external: boolean;
  irreversible: boolean;
  // 做完以后记一次主人操作（「不是我」能撤销的在 protocol 的 OWNER_ACTIONS 里写着）。没有时为 null。
  ownerAction: OwnerActionId | null;
  // 给 Lead 的一句话：什么时候用。进 ticket_action 的工具说明。
  hint: string;
  // user_direct 的操作：你在界面上去哪里点。Lead 调用被拒时，拒绝里写这一句。
  where?: string;
  // 你没写原因时账本里的说法。
  defaultReason: string;
  available(item: Item, env: TicketActionEnv): Availability | Promise<Availability>;
  // 只对 delegated：工单托管给 Lead，而且这一次在托管范围内（例如核查员对最新交付给了 PASS）。
  delegatedScope?(item: Item, env: TicketActionEnv): boolean;
  run(run: TicketActionRun<TicketActionInputs[K]>): unknown;
  effects?(run: TicketActionRun<TicketActionInputs[K]>, result: unknown): TicketActionEffects;
  // 操作成功以后要记的主人操作。没有变化时返回 null。
  ownerActionInput?(run: TicketActionRun<TicketActionInputs[K]>, result: unknown): OwnerActionInput | null;
}

export function permissionOf(definition: Pick<TicketActionDefinition, "permission">, item: Item): TicketActionPermission {
  return typeof definition.permission === "string" ? definition.permission : definition.permission(item);
}

export type TicketActionCatalog = { readonly [K in TicketActionId]: TicketActionDefinition<K> };

// stale：页面看到的已经过时了（例如别人刚改过这一条验收标准、交付已经更新）。刷新以后再做。
// user_direct：只有你本人能做的操作（授予 Lead 权力、带密钥），Lead 调用时总是这个拒绝。
// needs_confirmation：不可逆的操作没有带确认（input 的 confirm: true）。拒绝里写明会发生什么。
export type TicketActionErrorCode =
  | "not_found" | "invalid_input" | "unavailable" | "stale" | "needs_user_turn" | "forbidden" | "user_direct"
  | "needs_confirmation" | "external_turn";

// 操作层自己的拒绝。底层的错误（DeliveryError、ReviewerChangeError、状态机的错）原样抛出，由入口各自映射。
export class TicketActionError extends Error {
  constructor(readonly code: TicketActionErrorCode, message: string) {
    super(message);
    this.name = "TicketActionError";
  }
}
