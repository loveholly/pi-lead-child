// 子 agent 的权限清单（.scratch/confidence-model/landing.md 第 5 节，2026-10-22 定）。
//
// 一张由通道派出去的工单，它的 Run 带一份清单（RunGrant）。清单是「工具白名单加参数约束」：
//   - 每条规则（RunGrantRule）说一个连接上能调哪些工具，以及这些调用的参数必须是什么，
//     例如「只读 Acme/x」「只在 Acme/x#101 上发 COMMENT」「在 Acme/x#101 上可以 APPROVE」。
//   - 连接中心（packages/connections 的 ConnectionHub）在每一次调用时按清单检查参数（checkGrantCall），
//     不在清单里的拒绝，并记一条审计。子 agent 只看得到清单里的工具。
//
// 谁定、怎么算：
//   1. Lead 决定干什么、在哪儿干：意图（GrantIntent）和范围（GrantScope：哪个仓库、哪个 PR、要不要更窄）。
//   2. 代码算清单：清单 = 授权表按意图给的上限（IntentGrantBound）∩ Lead 选的范围（computeRunGrant）。
//      Lead 只能收窄：超出上限的部分被丢掉，并写进 dropped，Lead 能看到丢了什么。
//   3. 放宽只能由用户本人做（工单动作 widen_grant，凭已认证的配对用户轮次）。放宽用同一套范围（GrantScope），
//      不受意图的上限限制，但仍受两条硬性底线（GRANT_HARD_FLOORS）限制：这两条由连接中心的代码执行，清单写什么都放不开。
//
// 规则里的工具名是各个连接自己的线上名字（例如 GitHub MCP 的 pull_request_review_write）。
// 新加一个连接，只要给它写规则；新加一种任务，只要在上限表里加一行。中间的检查（checkGrantCall）不按连接、不按任务分支。
import { Type, type Static, type TProperties } from "typebox";
import { Value } from "typebox/value";
import type { HandbookAbility } from "./channel-handbook.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Literals = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((value) => Type.Literal(value))));

// ── 连接的名字 ──────────────────────────────────────────────────────────────────────

/** GitHub 连接的 key（connections 的目录）。 */
export const GITHUB_CONNECTION = "github";
/** 连接中心自带的本地仓库读取（packages/connections 的 local-repo.ts）。只读，路径由代码检查。 */
export const LOCAL_REPO_CONNECTION = "local";
/** CDP（客户数据平台）。它是一个自定义的远程 MCP，连接中心按服务器地址认出它，给它这个别名（C5）。 */
export const CDP_CONNECTION = "cdp";
/** Jira 和 Confluence。 */
export const ATLASSIAN_CONNECTION = "atlassian";

/** GitHub MCP 里和 review 有关的工具（github/github-mcp-server 的线上名字）。 */
export const GITHUB_REVIEW_TOOLS = {
  read: "pull_request_read",
  write: "pull_request_review_write",
  comment: "add_comment_to_pending_review",
} as const;

/** 发 review 时 pull_request_review_write 能用的 method。resolve_thread 一类会改 review 线程的状态，不在里面。 */
export const GITHUB_REVIEW_WRITE_METHODS = ["create", "submit_pending", "delete_pending"] as const;

/**
 * review 的结论。外部的人请你 review 时（DEFAULT_INTENT_GRANT_BOUNDS），REQUEST_CHANGES 不在任何意图的上限里：
 * 不能代你要求改动。你本人要的评审（USER_PR_REVIEW_BOUND）可以要求改动（你的笔记 #47，lead-self-routing spec B）。
 */
export const GRANT_REVIEW_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;
export type GrantReviewEvent = typeof GRANT_REVIEW_EVENTS[number];

/** 外部的人请你 review 时，请求里能写的结论（通道派活的格式，agent-tasks.ts）：没有 REQUEST_CHANGES。 */
export const EXTERNAL_REVIEW_EVENTS = ["COMMENT", "APPROVE"] as const;

// ── 意图和上限 ──────────────────────────────────────────────────────────────────────

/** 要干活的意图。名字和通道的信心模型（engine 的 confidence-model.ts 的 REQUEST_INTENTS）一致。 */
export const GRANT_INTENTS = ["code_review", "approve", "knowledge", "progress"] as const;
export type GrantIntent = typeof GRANT_INTENTS[number];

export const GrantIntentSchema = Literals(GRANT_INTENTS);

/**
 * 一个意图的上限（landing.md 第 5 节「按意图的缺省上限」）。
 *   repos            能读哪些仓库：pull_request 只能读 PR 所在的仓库；chosen 是 Lead 选的仓库。
 *   maxRepos         最多几个仓库（GitHub 和本地分开数）。
 *   pullRequest      这个意图是不是针对一个 PR。是时必须给 PR，否则不能给。
 *   reviewEvents     在这个 PR 上能发的 review 结论。空的就是不能写。
 *   connections      还能只读哪些连接（例如 CDP、Jira）。
 */
export const IntentGrantBoundSchema = StrictObject({
  repos: Literals(["pull_request", "chosen"] as const),
  maxRepos: Type.Integer({ minimum: 0, maximum: 8 }),
  pullRequest: Type.Boolean(),
  reviewEvents: Type.Array(Literals(GRANT_REVIEW_EVENTS), { maxItems: GRANT_REVIEW_EVENTS.length }),
  connections: Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 8 }),
});
export type IntentGrantBound = Static<typeof IntentGrantBoundSchema>;

/**
 * 缺省的上限表。通道的授权表（A5）定下来以后，派工单的人把它给的上限传进来（computeRunGrant 的 bound），
 * 这张表只在没传时用。所有意图都不给：shell、用户自己的 MCP、在来源里发消息（回复只由通道发）、读本机的私人文件。
 */
export const DEFAULT_INTENT_GRANT_BOUNDS: Readonly<Record<GrantIntent, IntentGrantBound>> = {
  // 代码 review：读这个仓库的 PR、diff、文件、已有评论；只在这个 PR 上发 COMMENT。
  code_review: { repos: "pull_request", maxRepos: 1, pullRequest: true, reviewEvents: ["COMMENT"], connections: [] },
  // 请你 approve：同上，另外可以 APPROVE（GitHub 的守卫再查四条）。
  approve: { repos: "pull_request", maxRepos: 1, pullRequest: true, reviewEvents: ["COMMENT", "APPROVE"], connections: [] },
  // 业务、技术咨询：Lead 选的几个仓库，CDP 的只读查询。不能写。
  knowledge: { repos: "chosen", maxRepos: 4, pullRequest: false, reviewEvents: [], connections: [CDP_CONNECTION] },
  // 项目进度：同上，再加 Jira 这类工具的只读查询。
  progress: { repos: "chosen", maxRepos: 4, pullRequest: false, reviewEvents: [], connections: [CDP_CONNECTION, ATLASSIAN_CONNECTION] },
};

/**
 * 交接说明一句的能力 → 派活的上限（自动代你处理方案 B，issue 04）。派活时的能力 = 这一句的能力（已经按对方的上限压过：
 * 做法不做事时是空的）∩ Lead 选的范围。
 *   - 在 PR 上评论、批准：只读 PR 所在的仓库，只在这个 PR 上写（批准另外要过 GitHub 的守卫）；
 *   - 读代码和文档：Lead 选的几个仓库；读连接：CDP、Jira 这类连接的只读查询；
 *   - 改代码、开 draft PR 不走这里（建编码工单，Lead 的 create_task）。
 * 没有一项派活的能力时是 null。
 */
export function abilitiesGrantBound(abilities: readonly HandbookAbility[]): IntentGrantBound | null {
  const has = (ability: HandbookAbility) => abilities.includes(ability);
  const reviewEvents: GrantReviewEvent[] = [
    ...(has("review_comment") || has("approve") ? ["COMMENT" as const] : []), ...(has("approve") ? ["APPROVE" as const] : []),
  ];
  const pullRequest = reviewEvents.length > 0;
  const connections = has("read_connections") ? [CDP_CONNECTION, ATLASSIAN_CONNECTION] : [];
  if (!pullRequest && !has("read_code") && !connections.length) return null;
  return {
    repos: pullRequest ? "pull_request" : "chosen", maxRepos: pullRequest ? 1 : has("read_code") ? 4 : 0,
    pullRequest, reviewEvents, connections,
  };
}

/**
 * 你本人要的 PR 评审，评审 agent 自己发时的上限（lead-self-routing spec B，你 2026-10-28 选的「只限这个 PR」）：
 * 只读 PR 所在的仓库，只在这个 PR 上建、加评论、提交评审。结论可以是 COMMENT、REQUEST_CHANGES；APPROVE 只在 Lead 按你的话
 * 要了时给（create_task 的 review_events）。PR 里别人写的文字没法让它往别的 PR、别的仓库、别的系统写。
 */
export const USER_PR_REVIEW_BOUND: IntentGrantBound = {
  repos: "pull_request", maxRepos: 1, pullRequest: true, reviewEvents: ["COMMENT", "REQUEST_CHANGES", "APPROVE"], connections: [],
};

/**
 * 两条硬性底线：用户下命令也不放。连接中心的代码执行它们，和清单无关：
 *   - 本地读取过禁止名单（.env、凭据、私钥、~/.pi-lead-child、日志），只能读清单里的仓库；
 *   - 写操作的参数里有像凭据或令牌的文字时拒绝。
 */
export const GRANT_HARD_FLOORS = [
  "不能读凭据和私密文件（.env、私钥、凭据文件、助手自己的数据目录和日志）",
  "不能把凭据或令牌发出去（写操作的参数里有像密钥的文字时拒绝）",
] as const;

// ── 范围（Lead 选的，或者用户放宽时给的） ──────────────────────────────────────────────

const GITHUB_REPO = "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$";

export const GrantPullRequestSchema = StrictObject({
  owner: Type.String({ minLength: 1, maxLength: 100 }),
  repo: Type.String({ minLength: 1, maxLength: 100 }),
  number: Type.Integer({ minimum: 1 }),
});
export type GrantPullRequest = Static<typeof GrantPullRequestSchema>;

/**
 * 一份范围。Lead 派工单时给它（不给的项按上限取满）；用户放宽时也给它（只写要加的）。
 *   repos            GitHub 仓库，owner/name。
 *   localRepos       本地仓库的名字（daemon 按候选仓库解析成根目录，解析不了的丢掉）。
 *   pullRequest      要 review 或 approve 的 PR。
 *   reviewEvents     在这个 PR 上能发的 review 结论。
 *   connections      要只读的其他连接（例如 cdp、atlassian）。
 */
const scopeProperties = <E extends readonly string[]>(events: E) => ({
  repos: Type.Optional(Type.Array(Type.String({ pattern: GITHUB_REPO, maxLength: 140 }), { maxItems: 8 })),
  localRepos: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 8 })),
  pullRequest: Type.Optional(GrantPullRequestSchema),
  reviewEvents: Type.Optional(Type.Array(Literals(events), { maxItems: events.length })),
  connections: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 8 })),
});
export const GrantScopeSchema = StrictObject(scopeProperties(GRANT_REVIEW_EVENTS));
export type GrantScope = Static<typeof GrantScopeSchema>;

/** 通道派活（外部的人请你做事）的范围：格式上就不能写 REQUEST_CHANGES（lead-self-routing spec B）。 */
export const ExternalGrantScopeSchema = StrictObject(scopeProperties(EXTERNAL_REVIEW_EVENTS));
export type ExternalGrantScope = Static<typeof ExternalGrantScopeSchema>;
export type ExternalReviewEvent = typeof EXTERNAL_REVIEW_EVENTS[number];

/** 外部请求里能写的结论（EXTERNAL_REVIEW_EVENTS）。 */
export function isExternalReviewEvent(event: string): event is ExternalReviewEvent {
  return (EXTERNAL_REVIEW_EVENTS as readonly string[]).includes(event);
}

// ── 清单 ────────────────────────────────────────────────────────────────────────────

/** 一个参数的约束：参数必须出现，并且等于其中一个值（字符串不分大小写）。optional 时可以不出现，出现了就要等于其中一个。 */
export const GrantArgRuleSchema = StrictObject({
  oneOf: Type.Array(Type.Union([Type.String({ maxLength: 200 }), Type.Number(), Type.Boolean()]), { minItems: 1, maxItems: 20 }),
  optional: Type.Optional(Type.Boolean()),
});
export type GrantArgRule = Static<typeof GrantArgRuleSchema>;

/**
 * 一条规则。
 *   id          在这份清单里唯一，放宽和撤销按它增删（例如 read:github:acme/x）。
 *   connection  连接的 key 或别名（github、local、cdp、atlassian、custom-3）。
 *   tools       "read" 是这个连接上所有只读的工具；数组是点名的这几个工具（可以是写工具）。
 *   args        参数约束。连接中心检查的是参数加上守卫从参数里认出的事实（例如 GitHub 搜索词里的 repo:）。
 *   label       给人看的一句话。
 */
export const RunGrantRuleSchema = StrictObject({
  id: Type.String({ minLength: 1, maxLength: 200 }),
  connection: Type.String({ minLength: 1, maxLength: 40 }),
  tools: Type.Union([Type.Literal("read"), Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 })]),
  args: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 60 }), GrantArgRuleSchema)),
  label: Type.String({ minLength: 1, maxLength: 200 }),
});
export type RunGrantRule = Static<typeof RunGrantRuleSchema>;

/** 清单里一个本地仓库：名字和根目录（绝对路径，由 daemon 从候选仓库解析）。github 是它的远端（owner/name），没有时不写。 */
export const GrantLocalRepoSchema = StrictObject({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  root: Type.String({ minLength: 1, maxLength: 1_000 }),
  github: Type.Optional(Type.String({ maxLength: 140 })),
});
export type GrantLocalRepo = Static<typeof GrantLocalRepoSchema>;

/**
 * 一个 Run 的清单。intent 是派工单时的意图；rules 是现在生效的规则（放宽以后包括放宽的那些）；
 * localRepos 是本地读取规则要的根目录。存在 store 的 run_grants 表里，连接中心每次调用都从库里读最新的一份。
 */
export const RunGrantSchema = StrictObject({
  version: Type.Literal(1),
  intent: GrantIntentSchema,
  rules: Type.Array(RunGrantRuleSchema, { maxItems: 40 }),
  localRepos: Type.Array(GrantLocalRepoSchema, { maxItems: 8 }),
});
export type RunGrant = Static<typeof RunGrantSchema>;

export function isRunGrant(value: unknown): value is RunGrant {
  return Value.Check(RunGrantSchema, value);
}

export class GrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantError";
  }
}

// ── 从范围生成规则 ──────────────────────────────────────────────────────────────────

const lower = (value: string) => value.toLowerCase();

function splitRepo(name: string): { owner: string; repo: string } {
  const at = name.indexOf("/");
  return { owner: name.slice(0, at), repo: name.slice(at + 1) };
}

function eventsLabel(events: readonly GrantReviewEvent[]): string {
  return events.map((event) => event === "APPROVE" ? "可以 APPROVE" : event === "REQUEST_CHANGES" ? "可以要求改动" : "发 COMMENT").join("，");
}

/** GitHub 仓库的只读规则。 */
export function githubReadRule(name: string): RunGrantRule {
  const { owner, repo } = splitRepo(name);
  return {
    id: `read:github:${lower(name)}`, connection: GITHUB_CONNECTION, tools: "read",
    args: { owner: { oneOf: [owner] }, repo: { oneOf: [repo] } },
    label: `只读 ${name}`,
  };
}

/**
 * 在一个 PR 上发 review 的两条规则：pull_request_review_write（只能 create、submit_pending、delete_pending，
 * event 只能是给的那几种）和 add_comment_to_pending_review（行内评论）。APPROVE 还要过 GitHub 守卫的四条检查。
 */
export function pullRequestReviewRules(pr: GrantPullRequest, events: readonly GrantReviewEvent[]): RunGrantRule[] {
  if (!events.length) return [];
  const name = `${pr.owner}/${pr.repo}#${pr.number}`;
  const target = { owner: { oneOf: [pr.owner] }, repo: { oneOf: [pr.repo] }, pullNumber: { oneOf: [pr.number] } };
  return [
    {
      id: `review:${lower(name)}:${[...events].sort().join("+").toLowerCase()}`,
      connection: GITHUB_CONNECTION, tools: [GITHUB_REVIEW_TOOLS.write],
      args: {
        ...target,
        method: { oneOf: [...GITHUB_REVIEW_WRITE_METHODS] },
        event: { oneOf: [...events], optional: true },
      },
      label: `只在 ${name} 上${eventsLabel(events)}`,
    },
    {
      id: `review-comment:${lower(name)}`, connection: GITHUB_CONNECTION, tools: [GITHUB_REVIEW_TOOLS.comment],
      args: target,
      label: `在 ${name} 的 review 里加行内评论`,
    },
  ];
}

/** 本地仓库的只读规则（连接中心的 local 连接，参数 repo 是仓库名）。 */
export function localReadRule(name: string): RunGrantRule {
  return {
    id: `read:local:${lower(name)}`, connection: LOCAL_REPO_CONNECTION, tools: "read",
    args: { repo: { oneOf: [name] } },
    label: `只读本地仓库 ${name}`,
  };
}

/** 一个连接的只读规则（例如 CDP、Jira）。 */
export function connectionReadRule(connection: string): RunGrantRule {
  return { id: `read:${lower(connection)}`, connection, tools: "read", label: `只读 ${connection}` };
}

/** 一份已经核对过的范围生成的规则。重复的规则（同一个 id）只留一条。 */
export function grantRulesForScope(scope: {
  repos: readonly string[];
  localRepos: readonly GrantLocalRepo[];
  pullRequest: GrantPullRequest | null;
  reviewEvents: readonly GrantReviewEvent[];
  connections: readonly string[];
}): RunGrantRule[] {
  const rules = [
    ...scope.repos.map(githubReadRule),
    ...(scope.pullRequest ? pullRequestReviewRules(scope.pullRequest, scope.reviewEvents) : []),
    ...scope.localRepos.map((entry) => localReadRule(entry.name)),
    ...scope.connections.map(connectionReadRule),
  ];
  return rules.filter((rule, index) => rules.findIndex((other) => other.id === rule.id) === index);
}

// ── 上限 ∩ Lead 选的范围 ──────────────────────────────────────────────────────────────

export interface ComputedRunGrant {
  grant: RunGrant;
  // 超出上限、被丢掉的部分（给 Lead 看的一句话一条）。Lead 只能收窄，所以超出的不报错，丢掉并告诉 Lead。
  dropped: string[];
}

/**
 * 算一个 Run 的清单：上限 ∩ Lead 选的范围。
 *   - scope 里没给的项按上限取满（Lead 不收窄时就是上限）；给了的项只留在上限里的部分。
 *   - 针对 PR 的意图必须给 PR，否则抛 GrantError；不针对 PR 的意图给了 PR，PR 被丢掉（PR 所在的仓库照样可以读）。
 *   - resolveLocalRepo 把本地仓库的名字解析成根目录（daemon 用候选仓库）。解析不了的丢掉。
 */
export function computeRunGrant(input: {
  intent: GrantIntent;
  scope: GrantScope;
  bound?: IntentGrantBound;
  resolveLocalRepo: (name: string) => GrantLocalRepo | null;
}): ComputedRunGrant {
  if (!(GRANT_INTENTS as readonly string[]).includes(input.intent)) throw new GrantError(`不认识的意图：${String(input.intent)}`);
  if (!Value.Check(GrantScopeSchema, input.scope)) {
    const first = [...Value.Errors(GrantScopeSchema, input.scope)][0];
    throw new GrantError(`范围的格式不对：${first ? `${(first as { instancePath?: string }).instancePath || "/"} ${first.message}` : "无法解析"}`);
  }
  const bound = input.bound ?? DEFAULT_INTENT_GRANT_BOUNDS[input.intent];
  const { scope } = input;
  const dropped: string[] = [];

  let pullRequest: GrantPullRequest | null = null;
  if (bound.pullRequest) {
    if (!scope.pullRequest) throw new GrantError("这个意图针对一个 PR，要给 pullRequest");
    pullRequest = scope.pullRequest;
  } else if (scope.pullRequest) {
    dropped.push(`这个意图不针对 PR，没有给 ${scope.pullRequest.owner}/${scope.pullRequest.repo}#${scope.pullRequest.number} 写权限`);
  }
  const prRepo = pullRequest ? `${pullRequest.owner}/${pullRequest.repo}` : null;

  // GitHub 仓库。
  let repos: string[];
  if (bound.repos === "pull_request") {
    repos = prRepo ? [prRepo] : [];
    for (const name of scope.repos ?? []) {
      if (!prRepo || lower(name) !== lower(prRepo)) dropped.push(`只能读 PR 所在的仓库，丢掉了 ${name}`);
    }
  } else {
    repos = [];
    const wanted = [...(scope.repos ?? []), ...(scope.pullRequest ? [`${scope.pullRequest.owner}/${scope.pullRequest.repo}`] : [])];
    for (const name of wanted) {
      if (repos.some((kept) => lower(kept) === lower(name))) continue;
      if (repos.length >= bound.maxRepos) dropped.push(`最多读 ${bound.maxRepos} 个 GitHub 仓库，丢掉了 ${name}`);
      else repos.push(name);
    }
  }

  // 本地仓库。
  const localRepos: GrantLocalRepo[] = [];
  for (const name of scope.localRepos ?? []) {
    const resolved = input.resolveLocalRepo(name);
    if (!resolved) {
      dropped.push(`找不到本地仓库 ${name}`);
      continue;
    }
    if (localRepos.some((kept) => lower(kept.name) === lower(resolved.name))) continue;
    if (bound.repos === "pull_request" && (!prRepo || !resolved.github || lower(resolved.github) !== lower(prRepo))) {
      dropped.push(`只能读 PR 所在的仓库，丢掉了本地仓库 ${name}`);
      continue;
    }
    if (localRepos.length >= bound.maxRepos) {
      dropped.push(`最多读 ${bound.maxRepos} 个本地仓库，丢掉了 ${name}`);
      continue;
    }
    localRepos.push(resolved);
  }

  // review 的结论。
  const allowedEvents = new Set<GrantReviewEvent>(bound.reviewEvents);
  const reviewEvents: GrantReviewEvent[] = [];
  for (const event of scope.reviewEvents ?? bound.reviewEvents) {
    if (!allowedEvents.has(event)) dropped.push(`这个意图不能发 ${event}`);
    else if (!reviewEvents.includes(event)) reviewEvents.push(event);
  }

  // 其他连接。
  const allowedConnections = new Set(bound.connections.map(lower));
  const connections: string[] = [];
  for (const connection of scope.connections ?? bound.connections) {
    if (!allowedConnections.has(lower(connection))) dropped.push(`这个意图不能用 ${connection}`);
    else if (!connections.some((kept) => lower(kept) === lower(connection))) connections.push(connection);
  }

  return {
    grant: {
      version: 1,
      intent: input.intent,
      rules: grantRulesForScope({ repos, localRepos, pullRequest, reviewEvents, connections }),
      localRepos,
    },
    dropped,
  };
}

/**
 * 用户放宽：把范围生成的规则加进清单（不受意图的上限限制）。已经有的规则不重复加。
 * 返回新清单和这次真正加上的规则（撤销时按它们的 id 删掉）。
 */
export function widenRunGrant(
  grant: RunGrant,
  scope: GrantScope,
  resolveLocalRepo: (name: string) => GrantLocalRepo | null,
): { grant: RunGrant; added: RunGrantRule[]; addedLocalRepos: GrantLocalRepo[]; unresolved: string[] } {
  if (!Value.Check(GrantScopeSchema, scope)) throw new GrantError("范围的格式不对");
  if (scope.reviewEvents?.length && !scope.pullRequest) throw new GrantError("要给 review 结论，必须同时给 pullRequest");
  const unresolved: string[] = [];
  const addedLocalRepos: GrantLocalRepo[] = [];
  const localForRules: GrantLocalRepo[] = [];
  for (const name of scope.localRepos ?? []) {
    const existing = grant.localRepos.find((entry) => lower(entry.name) === lower(name));
    const resolved = existing ?? resolveLocalRepo(name);
    if (!resolved) {
      unresolved.push(name);
      continue;
    }
    localForRules.push(resolved);
    if (!existing && !addedLocalRepos.some((entry) => lower(entry.name) === lower(resolved.name))) addedLocalRepos.push(resolved);
  }
  const pr = scope.pullRequest;
  const candidates = grantRulesForScope({
    // 给了 PR 时，PR 所在的仓库也可以读。
    repos: [...(scope.repos ?? []), ...(pr ? [`${pr.owner}/${pr.repo}`] : [])],
    localRepos: localForRules,
    pullRequest: scope.pullRequest ?? null,
    reviewEvents: scope.reviewEvents ?? [],
    connections: scope.connections ?? [],
  });
  const added = candidates.filter((rule) => !grant.rules.some((existing) => existing.id === rule.id));
  return {
    grant: { ...grant, rules: [...grant.rules, ...added], localRepos: [...grant.localRepos, ...addedLocalRepos] },
    added,
    addedLocalRepos,
    unresolved,
  };
}

/** 撤销一次放宽：删掉这些 id 的规则和这些本地仓库（还有别的规则在用的本地仓库留下）。 */
export function withoutGrantRules(grant: RunGrant, ruleIds: readonly string[], localRepoNames: readonly string[] = []): RunGrant {
  const rules = grant.rules.filter((rule) => !ruleIds.includes(rule.id));
  const usedLocal = new Set(rules.filter((rule) => rule.connection === LOCAL_REPO_CONNECTION)
    .flatMap((rule) => (rule.args?.repo?.oneOf ?? []).map((value) => lower(String(value)))));
  const drop = new Set(localRepoNames.map(lower));
  return { ...grant, rules, localRepos: grant.localRepos.filter((entry) => !drop.has(lower(entry.name)) || usedLocal.has(lower(entry.name))) };
}

// ── 每一次调用的检查 ──────────────────────────────────────────────────────────────────

export interface GrantCall {
  // 连接的 key，和它的别名（例如 custom-3 的别名 cdp）。规则写哪一个都认。
  connection: string;
  aliases?: readonly string[];
  tool: string;
  // 这个工具是不是只读（服务器标了 readOnlyHint，或者连接中心自带的只读工具）。
  readOnly: boolean;
  // 参数，加上守卫从参数里认出的事实（例如 GitHub 搜索词里 repo: 后面的 owner 和 repo）。事实优先于同名的参数。
  facts: Readonly<Record<string, unknown>>;
}

export type GrantCheck =
  | { ok: true; rule: RunGrantRule }
  | { ok: false; reason: string };

function sameValue(allowed: string | number | boolean, actual: unknown): boolean {
  if (typeof allowed === "string") return typeof actual === "string" && lower(actual) === lower(allowed);
  if (typeof allowed === "number") return actual === allowed || (typeof actual === "string" && actual.trim() !== "" && Number(actual) === allowed);
  return actual === allowed;
}

function argProblem(rule: RunGrantRule, facts: Readonly<Record<string, unknown>>): string | null {
  for (const [name, constraint] of Object.entries(rule.args ?? {})) {
    const value = facts[name];
    if (value === undefined || value === null) {
      if (constraint.optional) continue;
      return `要给参数 ${name}（只能是 ${constraint.oneOf.join("、")}）`;
    }
    if (!constraint.oneOf.some((allowed) => sameValue(allowed, value))) {
      return `参数 ${name} 是 ${typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "别的值"}，只能是 ${constraint.oneOf.join("、")}`;
    }
  }
  return null;
}

/**
 * 这一次调用在不在清单里。有一条规则放行就放行；都不放行时，给出最接近的那条规则说的原因。
 * 只看清单。守卫（例如 APPROVE 的四条检查）和硬性底线由连接中心另外检查。
 */
export function checkGrantCall(grant: RunGrant, call: GrantCall): GrantCheck {
  const names = new Set([call.connection, ...(call.aliases ?? [])].map(lower));
  const onConnection = grant.rules.filter((rule) => names.has(lower(rule.connection)));
  if (!onConnection.length) return { ok: false, reason: `清单里没有 ${call.connection} 这个连接` };
  const forTool = onConnection.filter((rule) => rule.tools === "read" ? call.readOnly : rule.tools.includes(call.tool));
  if (!forTool.length) {
    return {
      ok: false,
      reason: call.readOnly
        ? `清单里没有 ${call.connection} 的 ${call.tool}`
        : `${call.tool} 会写入 ${call.connection}，清单里没有这个写操作`,
    };
  }
  let reason: string | null = null;
  for (const rule of forTool) {
    const problem = argProblem(rule, call.facts);
    if (problem === null) return { ok: true, rule };
    reason ??= `${problem}（规则：${rule.label}）`;
  }
  return { ok: false, reason: reason ?? `清单不允许这次调用` };
}

/** 清单里点到的连接（key 或别名）。 */
export function grantConnections(grant: RunGrant): string[] {
  return [...new Set(grant.rules.map((rule) => rule.connection))];
}

/** 给人看的清单：每条规则一句话。 */
export function describeRunGrant(grant: RunGrant): string[] {
  return grant.rules.map((rule) => rule.label);
}
