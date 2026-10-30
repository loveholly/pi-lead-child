// 第一批常设指令（Lead 事件主干 spec D4，工单 05）：从写死在代码里的规则搬过来，行为不变。
//
// 这是作者为 system 的种子。openDb 时 syncSystemStandingOrders 把它们写进 standing_orders，只往前走：
//   - 库里没有的写成第 1 版；
//   - 库里最新一版是 system 写的、它的修订号（seed_revision）小于这里的 seedRevision 时，写一个新版本；
//   - 修订号相等或更大时不写，即使内容不同：部署时旧版本的进程（每个 Run 的 mcp-server、supervisor）也会打开同一个库；
//   - Lead 或用户改过的（第 3 期）不覆盖。
// 改一条种子的内容时，把它的 seedRevision 加 1。要停用一条系统指令，不要删掉它：留着它，status 写 disabled，修订号加 1。
// 库里读不到（表坏了、版本不合格）时，规则层直接用这里的内容，依据记成第 0 版。
//
// 定级别的指令按 priority 从小到大匹配，第一条匹配的定级别。顺序照搬 01 的默认分诊（defaultTriageLevel）：
//   跟进设下 → 熔断折进来的 → 要叫醒 Lead 的 → 瞬时重试、模型目录的说明 → 其余 inbox → 提醒的通知 → 其余通知 → 跟进到点。
// 都不匹配时按来源的默认级别（source.*）。
import {
  CHANNEL_AUTHORITY_DEFAULTS, CHANNEL_HANDBOOK_DEFAULTS, type StandingOrderDefinition, type StandingOrderStatus,
} from "@pi-lead-child/protocol";

/** 一条系统种子：指令的内容，加上它的修订号和状态（缺省 active）。 */
export interface SystemStandingOrderSeed extends StandingOrderDefinition {
  seedRevision: number;
  status?: StandingOrderStatus;
}

const MINUTE = 60_000;
const INBOX_KINDS = ["inbox.blocker", "inbox.attention"];

export const SYSTEM_STANDING_ORDERS: readonly SystemStandingOrderSeed[] = [
  // ── 定级别 ────────────────────────────────────────────────────────────────────────
  {
    id: "inbox.lead_followup_set",
    seedRevision: 1,
    title: "Lead 给自己设跟进时只记录",
    priority: 10,
    condition: { kinds: INBOX_KINDS, fields: { "payload.inboxKind": "lead_followup" } },
    action: { type: "level", level: "record" },
    limits: null,
    escalateTo: null,
    reason: "搬自 01 的默认分诊：跟进设下时不用处理，到点那一条（timer.fired）才告诉 Lead（timer.lead_followup）。",
  },
  {
    id: "inbox.fuse_blockers",
    seedRevision: 1,
    title: "同一范围 1 小时内第 3 条 blocker 起熔断，之后折进来的只进摘要",
    priority: 20,
    condition: { kinds: INBOX_KINDS, fields: { "payload.delivery": "folded", "payload.fuseOpened": { not: true } } },
    action: { type: "rule", rule: "inbox.fuse_blockers", params: {}, level: "digest" },
    limits: { count: 3, windowMs: 60 * MINUTE },
    escalateTo: "tell",
    reason: "搬自 inbox.ts 的熔断（FUSE_THRESHOLD = 3，窗口 1 小时）。同一个 dedup_scope 1 小时内已有 2 条 blocker 时，"
      + "第 3 条起折进一行「异常频繁」。打开熔断的那一条照常告诉 Lead；之后折进来的只加计数，进摘要。lossless 的行不熔断。",
  },
  {
    id: "inbox.wake_lead",
    seedRevision: 1,
    title: "要叫醒 Lead 的事告诉 Lead：blocker（标了不叫醒的除外），以及标了叫醒的 attention",
    priority: 30,
    condition: { kinds: INBOX_KINDS, fields: { "payload.wakeLead": true } },
    action: {
      type: "rule",
      rule: "inbox.wake_lead",
      params: {
        // 看 inbox 的一行（severity 和 payload）。inboxWakesLead 和事件的 wakeLead 标记都按它算。
        wakeWhen: {
          anyOf: [
            { fields: { severity: "blocker", "payload.wakeLead": { not: false } } },
            { fields: { "payload.wakeLead": true } },
          ],
        },
      },
      level: "tell",
    },
    limits: null,
    escalateTo: null,
    reason: "搬自 inbox.ts 的 inboxWakesLead：blocker 总是叫醒 Lead，除非明确标了 wakeLead=false（例如 Lead 自己发起的决定）；"
      + "attention 只有标了 wakeLead=true 的才叫醒。内部来源现在不打断 Lead 正在进行的回合，所以不升到 interrupt。",
  },
  {
    id: "run.transient_retry",
    seedRevision: 1,
    title: "瞬时失败自动重试：等 30 秒起翻倍，最长 10 分钟，最多 5 次；重试的说明进摘要",
    priority: 35,
    condition: { kinds: ["inbox.attention"], fields: { "payload.inboxKind": "transient_retry" } },
    action: { type: "rule", rule: "run.transient_retry", params: { baseMs: 30_000, maxMs: 10 * MINUTE }, level: "digest" },
    limits: { count: 5 },
    escalateTo: "tell",
    reason: "搬自 engine 的 transient-retry.ts。只对 scope=attempt、retry=backoff 的失败生效（这个条件写在代码里：kernelRetriesTransient）。"
      + "第 n 次重试等 baseMs·2ⁿ⁻¹，最多等 maxMs；limits.count 是最多几次，代码另外把它限制在 20 以内。"
      + "到上限后工单转 blocked，升起一条 blocker（transient_retry_exhausted）。环境变量 PLC_TRANSIENT_RETRY_* 优先于这里。",
  },
  {
    id: "model_catalog.announce",
    // 修订 2（工单 14）：加 stableRefreshes: 2，目录去抖。
    seedRevision: 2,
    title: "模型目录有变化时告诉 Lead：连续两次刷新的结果相同才算变化，不叫醒它，进摘要",
    priority: 36,
    condition: { kinds: ["inbox.attention"], fields: { "payload.inboxKind": "model_catalog_changed" } },
    action: {
      type: "rule",
      rule: "model_catalog.announce",
      params: { announceFirstRefresh: false, refreshOnFailureScopes: ["runtime", "account"], wakeLead: false, stableRefreshes: 2 },
      level: "digest",
    },
    limits: null,
    escalateTo: "tell",
    reason: "搬自 daemon 的 model-catalog-watch.ts。daemon 启动后的第一次刷新不写说明（Lead 的工具描述在它之后才生成）；"
      + "Run 的失败作用域是 runtime 或 account 时马上再刷新一次；目录有变化才写一条 attention，不叫醒 Lead。"
      + "同时进行的刷新共用一次（engine 的 refreshModelCatalog）。"
      + "修订 2（工单 14）：2026-10-16 目录一天抖动 6 次，每次都写一条说明。现在连续 stableRefreshes 次刷新的结果相同"
      + "才算一次变化；抖一次又变回去的不写。说明写的是 Lead 上一次知道的目录和现在的目录之间的差别。",
  },
  {
    id: "inbox.no_wake",
    seedRevision: 1,
    title: "不叫醒 Lead 的事进摘要",
    priority: 40,
    condition: { kinds: INBOX_KINDS },
    action: { type: "level", level: "digest" },
    limits: null,
    escalateTo: "tell",
    reason: "搬自 01 的默认分诊：不叫醒 Lead 的 inbox（完成、进展、自动处理的说明）攒到 Lead 的下一轮。",
  },
  {
    id: "reminder.fire",
    // 修订 2（工单 07）：到点时 daemon 直接推送（不等 Lead），会话里马上出现到点卡，按提醒的级别交给 Lead；没确认时按提醒的设置重复推送。
    seedRevision: 2,
    title: "提醒到点：daemon 准时推送（不等 Lead），会话里出现到点卡，按提醒的级别交给 Lead；没确认时按提醒的设置重复推送",
    priority: 45,
    condition: { kinds: ["notification.created"], fields: { "payload.notificationKind": "reminder", "payload.urgency": "immediate" } },
    action: {
      type: "rule",
      rule: "reminder.fire",
      params: { notificationKind: "reminder", urgency: "immediate", titlePrefix: "提醒：" },
      level: "tell",
    },
    limits: null,
    escalateTo: null,
    reason: "搬自 engine 的 scheduler.ts：提醒到点时 scheduled → fired，同时写一条即时通知，走 notifications（不去抖）。"
      + "提醒到点一定发通知是硬性规则：这条指令只给参数，不能关掉。"
      + "修订 2（工单 07，2026-10-17 用户决定）：到点时三件事同时发生，前两件不等 Lead。"
      + "1. daemon 在 scheduler 那一拍直接推送（走用户的通知通道；没人在看会话、或者提醒是 interrupt 级时也弹桌面通知），每次推送记一条 reminder.pushed，依据是这条指令；"
      + "2. 会话里马上出现到点卡（到点事件 timer.fired，只显示，不打断 Lead 正在写的回答）；"
      + "3. 按提醒创建时定的级别交给 Lead：interrupt 插进当前回合，tell 排在这一轮后面。"
      + "提醒设了提前提醒的，到时间先推一次；设了重复推送的，没确认时按间隔再推，推满次数、又过了一个间隔还没确认，记一条 reminder.unacknowledged（digest），进回来简报。"
      + "用户确认、改时间或取消以后不再推。通知的 kind、urgency 和标题前缀仍然来自这里的参数。",
  },
  {
    id: "notification.immediate",
    seedRevision: 1,
    title: "给用户的即时通知告诉 Lead",
    priority: 50,
    condition: { kinds: ["notification.created"], fields: { "payload.urgency": "immediate" } },
    action: { type: "level", level: "tell" },
    limits: null,
    escalateTo: null,
    reason: "搬自 01 的默认分诊：即时通知由 Lead 决定怎样告诉用户（daemon 的通知播报）。",
  },
  {
    id: "notification.batchable",
    seedRevision: 1,
    title: "可批量的通知进摘要",
    priority: 51,
    condition: { kinds: ["notification.created"], fields: { "payload.urgency": "batchable" } },
    action: { type: "level", level: "digest" },
    limits: null,
    escalateTo: "tell",
    reason: "搬自 01 的默认分诊：可批量的通知（例如逾期）不单独交给 Lead。",
  },
  {
    id: "timer.lead_followup",
    seedRevision: 1,
    title: "Lead 给自己设的跟进到点：告诉 Lead",
    priority: 60,
    condition: { kinds: ["timer.fired"], fields: { "payload.wakeLead": true } },
    action: { type: "level", level: "tell" },
    limits: null,
    escalateTo: null,
    reason: "搬自 01 的默认分诊：跟进到点叫醒 Lead。提醒到点的 timer.fired 只记录，它的即时通知另有一条事件（reminder.fire）。",
  },

  // ── 规则 ──────────────────────────────────────────────────────────────────────────
  {
    id: "inbox.merge_attention",
    seedRevision: 1,
    title: "同一范围还没处理的 attention 合并成一行（lossless 的除外）",
    priority: 100,
    condition: { kinds: ["inbox.attention"] },
    action: { type: "rule", rule: "inbox.merge_attention", params: {} },
    limits: null,
    escalateTo: null,
    reason: "搬自 inbox.ts 的去抖：同一个 dedup_scope 已有一条 pending 的 attention 时，新的一条并进那一行（计数和最新的摘要），"
      + "每一条原文仍各有一条事件（工单 01）。lossless 的行不合并。",
  },
  {
    id: "events.merge_root_cause",
    seedRevision: 1,
    title: "根因相同的事件合成一条：同一种事件，30 分钟内，根因是基础设施类的",
    priority: 100,
    condition: {
      fields: { "rootCause.code": { exists: true } },
      anyOf: [
        { fields: { "rootCause.scope": { in: ["attempt", "runtime", "account", "host"] } } },
        { fields: { "payload.inboxKind": { in: ["transient_retry"] } } },
      ],
    },
    action: { type: "rule", rule: "events.merge_root_cause", params: {} },
    limits: { windowMs: 30 * MINUTE },
    escalateTo: null,
    reason: "spec D3：同一个根因（root_cause.code 相同）的多个事件合在一起，Lead 说一次。只合并还没有处置、级别相同、"
      + "不是 record 的同一种事件；后来的记成 superseded，指向第一条。工单自己的失败（scope=task、unknown）不合并：码相同不等于原因相同。",
  },
  {
    id: "events.escalate_overdue",
    seedRevision: 1,
    title: "到时限（30 分钟）还没有处置的事件升一级",
    priority: 100,
    condition: {},
    action: { type: "rule", rule: "events.escalate_overdue", params: { ladder: { digest: "tell", auto: "tell" } } },
    limits: { count: 100, windowMs: 30 * MINUTE },
    escalateTo: null,
    reason: "spec D3：到时限还没有处置的事件自动升一级。升到哪一级先看给它定级别的那条指令的 escalateTo，没写（或者没有依据）时"
      + "按 ladder；不超过来源的打断阈值（source.*）。原事件记成 superseded，另写一条 event.escalated。每一轮最多升 limits.count 条。"
      + "内部来源最高 tell，所以 tell 级的事件不再升，到时限还没有处置时由「没有处置的事件」这个不变量报告。",
  },
  {
    id: "events.digest_batch",
    seedRevision: 1,
    title: "摘要按批交给 Lead：最早的一条等满 25 分钟，或者用户回来时",
    priority: 100,
    condition: {},
    action: { type: "rule", rule: "events.digest_batch", params: { maxWaitMs: 25 * MINUTE, onUserReturn: true } },
    limits: null,
    escalateTo: null,
    reason: "spec D3：digest 级的事件按批处理，最长间隔 30 分钟，用户回来时也处理。等 25 分钟而不是 30 分钟："
      + "留 5 分钟给这一批的回合，30 分钟的时限一到，还没有处置的会被 events.escalate_overdue 升级。",
  },
  ...(["ticket", "run", "timer", "lead", "system"] as const).map((source): SystemStandingOrderSeed => ({
    id: `source.${source}`,
    seedRevision: 1,
    title: `来源 ${source}：默认只记录，最高到 tell（不打断 Lead 正在进行的回合）`,
    priority: 100,
    condition: { sources: [source] },
    action: { type: "rule", rule: "source.threshold", params: { source, defaultLevel: "record", maxLevel: "tell" } },
    limits: null,
    escalateTo: null,
    reason: "内部来源按现在的行为：其余事件只记录；没有一种内部事件插进 Lead 正在进行的回合（blocker 也是排在这一轮后面）。",
  })),
  {
    id: "source.external",
    seedRevision: 1,
    title: "外部来源（Slack、webhook 等，还没接）：默认进摘要，最高到 tell，永不打断 Lead 的回合",
    priority: 100,
    condition: {},
    action: { type: "rule", rule: "source.threshold", params: { source: "*", defaultLevel: "digest", maxLevel: "tell" } },
    limits: null,
    escalateTo: null,
    reason: "spec D3、D6：外部来源的事件永远不插进 Lead 正在进行的回合，紧急程度只影响怎样投递给用户。"
      + "没有自己指令的来源用这一条，先留默认值，接入时（工单 11）给每个来源写自己的指令。",
  },
  {
    id: "triage.jev",
    seedRevision: 1,
    title: "Jev 分诊：规则定不了的事件由 Jev 判断，按事件类型启用；缺省全部关闭，只做影子判断",
    priority: 100,
    condition: {},
    action: { type: "rule", rule: "triage.jev", params: { enabledKinds: [] } },
    limits: null,
    escalateTo: null,
    reason: "spec D12，工单 09：级别来自来源默认指令（source.*）的事件，daemon 在后台按批问 Jev 一组固定的问题"
      + "（重要程度、要不要 Lead 推理、能不能自动处理、风险），判断只记进影子表和决策日志，不改级别、依据和处置。"
      + "一致率（get_triage_shadow_report）达标的类型，由用户批准后写进 enabledKinds 才启用；"
      + "只有用户写的、或者用户批准过的版本算数。启用以后的行为由以后的工单实现。",
  },
  {
    id: "channel.authority",
    seedRevision: 1,
    title: "授权表：别人通过外部来源找你时，助手按对方的意图能替你做什么",
    priority: 100,
    condition: {},
    action: { type: "rule", rule: "channel.authority", params: { source: "*", intents: CHANNEL_AUTHORITY_DEFAULTS } },
    limits: null,
    escalateTo: null,
    reason: "用户 2026-10-22（落地计划 A5）：代码 review、approve、业务和技术咨询、项目进度，助手去干活（以后由 Lead 派工单）；"
      + "收尾的话，对方谢你、附和或感叹回个表情，你该谢对方、对方告别时私信里代你说一句，频道里回表情；"
      + "会议的邀约和提醒只提醒你；问涉密信息的（你的私人数据、助手的日志和配置、凭据、薪资职级）用固定的话拒绝；别的问你。"
      + "外部客户、外部共享的对话什么都不代你发（硬性规则）。涉密的永远不能替你做（硬性规则）。收紧 Lead 可以直接改，放开要你批准。",
  },
  {
    id: "channel.handbook",
    // 第 2 版（2026-10-30，issue 04）：「有人请我实现需求」加上改代码的能力（做法不变，还是交给你）。
    // 第 3 版（2026-10-30，issue 11）：「只是通知我一声的」的例句加上群发的通知或者提醒。
    // 第 4 版（2026-10-30）：例句里的单号换成虚构的（仓库公开，不写真实的内部单号）。
    seedRevision: 4,
    title: "交接说明：别人通过外部来源找你时，助手按哪一句、怎么处理",
    priority: 100,
    condition: {},
    action: { type: "rule", rule: "channel.handbook", params: CHANNEL_HANDBOOK_DEFAULTS as unknown as Record<string, unknown> },
    limits: null,
    escalateTo: null,
    reason: "用户 2026-10-30 选定方案 B（.scratch/auto-handling-handbook/spec.md）：每种情况一句话、一种做法；"
      + "对方是外部的人、客户、认不出的人时有上限；借权限、收不回的事、凭据和薪资、改规则四条底线写在代码里。"
      + "以后取代授权表（channel.authority）。放宽要你本人改，收紧 Lead 可以直接改。",
  },
];

// ── 来源插件的种子（工单 11）──────────────────────────────────────────────────────────
// 外部来源的默认常设指令（打断阈值、投递、代你行动的参数）由来源插件提供：engine 的通道 registry 登记适配器时调用
// registerSystemStandingOrderSeeds。它们和上面的种子一样是作者为 system 的种子，同步规则也一样（只往前走）。
// 没有登记这个插件的进程（每个 Run 的 mcp-server、supervisor）打开同一个库时看不到它们，同步也不会删掉它们。
const pluginSeeds = new Map<string, SystemStandingOrderSeed>();

/** 登记来源插件的种子。同一条种子（编号和内容都相同）登记两次不报错；编号和内置种子或别的插件冲突时报错。 */
export function registerSystemStandingOrderSeeds(seeds: readonly SystemStandingOrderSeed[]): void {
  for (const seed of seeds) {
    if (SYSTEM_STANDING_ORDERS.some((builtin) => builtin.id === seed.id)) {
      throw new Error(`常设指令 ${seed.id} 是内置的种子，插件不能再登记`);
    }
    const existing = pluginSeeds.get(seed.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(seed)) {
      throw new Error(`常设指令 ${seed.id} 已经由别的插件登记了`);
    }
  }
  for (const seed of seeds) pluginSeeds.set(seed.id, seed);
}

/** 全部系统种子：内置的，加上登记过的插件种子。 */
export function systemStandingOrderSeeds(): readonly SystemStandingOrderSeed[] {
  return pluginSeeds.size ? [...SYSTEM_STANDING_ORDERS, ...pluginSeeds.values()] : SYSTEM_STANDING_ORDERS;
}
