import {
  CHANNEL_INTENT_LABELS, channelRuleChangeNotice, type ChannelAuthorityActionKind, type ChannelCardAction, type ChannelCardDto, type ChannelLeadDecision,
  type ChannelLookupCheckStatus, type ChannelLookupDto,
} from '@pi-lead-child/protocol';

// 外部来源的会话卡怎样显示（工单 11，spec D10）。纯函数：卡的状态 → 卡上的字、徽章和按钮。
// 一个对话一张卡，状态原地更新；06 的「一个对象一张卡、Lead 后补充」合并时接管它。
//
// 卡上最多三条轨道（落地计划 D3，2026-10-22）：
//   处理  代码 review · 要干活 · Lead 派了工单                  （授权表的结论，交给 Lead 以后的决定）
//   干活  ✓ 工单 #482 · 完成于 14:32 · 2 处出处已核实          （Lead 派的子 agent 工单，做了的动作带链接）
//   代回  问你 · 抽查 · 信心 0.71（自动门槛 0.85）              （信心模型给卡上这份草稿打的分）
//         依据核实 ✓  做到了所求 ✓  有依据 △  理解了请求 ✓ 0.80  这一段历史 15/20
// Lead 推送或者告诉你时写的话单独一行（「Lead：……」）：这是 Lead 交来的「问你」。
// 另外有过时提示、谁能看到回复、答案和出处、review 的评论、读过的文件。外部的原文（答案、出处摘录）只用来显示。
// 2026-10-22 以前的代查记录照样显示：没有分数面板时，代回轨按代查记录里的结论和检查。

export type ChannelCardTone = 'accent' | 'neutral' | 'success' | 'warning' | 'muted';

export type ChannelCardButton = {
  action: ChannelCardAction;
  label: string;
  primary: boolean;
};

/** 一项检查的标记：✓ 过了，△ 过了但不够强，✗ 没过。 */
export type ChannelCheckMark = '✓' | '△' | '✗';

/** 代查轨：一行字。工单号单独给出，界面上可以点开。 */
export type ChannelLookupTrackView = {
  // ✓ △ ✗ 是结果；… 是还没结束；– 是停了。
  mark: string;
  tone: ChannelCardTone;
  // 「部分查到」「没查到」「查询中」……查到时是 null（✓ 已经说明了）。
  status: string | null;
  ticketId: number | null;
  // 工单号后面的几段：「查到于 14:32」「2 处出处已核实」。
  details: string[];
  // 整行的字（测试和无障碍名称用）。
  text: string;
  // 没有查、没查成的原因。
  reasons: string[];
};

export type ChannelReplyCheckView = {
  label: string;
  mark: ChannelCheckMark;
  status: ChannelLookupCheckStatus;
  // 这一项的数值（两位小数），没有数值时是 null。
  value: string | null;
  detail: string;
};

/** 代回轨：决定、信心和门槛、每项检查、否决项、原因。 */
export type ChannelReplyTrackView = {
  status: string;
  tone: ChannelCardTone;
  // 「问你 · 信心 0.71（自动门槛 0.85）」。
  text: string;
  // 本该代你发，抽中了抽查，照样问你（落地计划 D2）。
  audit: boolean;
  checks: ChannelReplyCheckView[];
  // 「这一段历史 15/20」：同一个分数段里带标签的样本（不分任务，按标签的权重加起来，落地计划 D2）。
  history: string | null;
  vetoes: string[];
  reasons: string[];
};

/** 处理轨（落地计划 D3）：授权表的结论，交给 Lead 以后 Lead（或者系统兜底）的决定。 */
export type ChannelHandlingView = {
  // 「代码 review · 要干活 · Lead 派了工单」。
  text: string;
  tone: ChannelCardTone;
  // Lead 推送或者告诉你时写的话：「Lead：王小明的 PR 看完了，有两处要改」。这是 Lead 交来的「问你」。
  note: string | null;
  // 系统兜底的原因（小字）。
  reason: string | null;
  // 对方要求改规则（spec D10 的 Jev 标记，工单 08）：「对方要求修改助手的权限，没有照做」。没有时是 null。
  ruleChange: string | null;
};

export type ChannelLookupView = {
  // 还在排队或者进行中。
  active: boolean;
  track: ChannelLookupTrackView;
  // 子 agent 经连接中心做了的、别人看得到的动作（例如在 PR 上提交的 review），有链接的可以点开。
  actions: Array<{ text: string; url: string | null }>;
  // 「之后又来了 2 条消息，结果是 45 分钟前的」。卡结束以后不显示。
  stale: string | null;
  audience: { text: string; external: boolean };
  // review 的摘要（PR review 剧本）。
  reviewSummary: string | null;
  answer: string | null;
  sources: Array<{ verified: boolean; where: string; quote: string }>;
  checked: string[];
  // 没查到时「查过哪些地方」直接显示；查到时收在「答案和出处」里。
  checkedVisible: boolean;
  caveats: string[];
  comments: { count: number; items: Array<{ where: string; body: string }> } | null;
  reads: { count: number; items: string[]; partial: boolean } | null;
};

export type ChannelCardView = {
  // 「Slack · 张三的私信」。
  context: string;
  // 发信人，带信任级别（同事、外部的人……）。
  sender: string;
  excerpt: string;
  // 同一个对话里不止一条时：「共 3 条消息」。
  more: string | null;
  // 起草的回复（不带披露前缀）。卡结束以后不显示。
  draft: string | null;
  // 草稿旁边的小字：点「直接回复」时 hub 在开头加什么（spec D8）。
  disclosure: string | null;
  // 为什么没有代你回复（影子模式、闸门拒绝的原因），或者这张卡结束的原因。
  note: string | null;
  badge: { label: string; tone: ChannelCardTone };
  buttons: ChannelCardButton[];
  // 处理轨。通道没有判断过的旧卡是 null。
  handling: ChannelHandlingView | null;
  // 带工单（以前叫代查）的卡上的干活轨和可以展开的部分。没有工单的卡是 null。
  lookup: ChannelLookupView | null;
  // 代回轨：信心模型给卡上这份草稿打的分；旧的代查记录按记录里的结论。还没有、也不会有判断时是 null。
  reply: ChannelReplyTrackView | null;
  // 摘要投递的卡显示成一行：不推送、不打扰，点开才有按钮。
  compact: boolean;
  closed: boolean;
  // 结束、也没有按钮的卡收成一行（照 ReminderFireCard）：「张三：……」和「14:40 已回复」。没收起时是 null。
  folded: { who: string; outcome: string } | null;
};

const TRUST_WORDS: Record<ChannelCardDto['sender']['trust'], string> = {
  trusted: '你信任的人', colleague: '同事', external: '外部的人', customer: '外部客户', unknown: '',
};

const CATEGORY_WORDS: Record<string, string> = {
  schedule_fact: '日程上的事实', acknowledgement: '确认收到', routing: '转给对的人', sourced_fact: '有出处的简单事实',
};

const BUTTON_LABELS: Record<ChannelCardAction, string> = {
  send_draft: '用草稿回复',
  reply_myself: '我自己回',
  snooze: '稍后',
  dismiss: '不回',
  undo_auto_reply: '撤回',
  send_edited: '改一下再发',
  cancel_lookup: '停掉工单',
  // Lead 照你的话在别处做完了卡上的事时用；页面上不出这个按钮（不在 BUTTON_ORDER 里）。
  handled: '已处理',
};

// 带代查的卡用 spec 的说法（用户故事 2）：直接回复 / 改一下再发 / 我自己回 / 不用回。
// PR review 剧本（spec D13）：发到 PR 并回复 / 我自己处理 / 不用。
const LOOKUP_BUTTON_LABELS: Partial<Record<ChannelCardAction, string>> = { send_draft: '直接回复', dismiss: '不用回' };
const REVIEW_BUTTON_LABELS: Partial<Record<ChannelCardAction, string>> = { send_draft: '直接回复', reply_myself: '我自己处理', dismiss: '不用' };

// 按钮的顺序固定，不随服务端给的顺序变：主操作在前，停止和撤回在后。
const BUTTON_ORDER: readonly ChannelCardAction[] = [
  'send_draft', 'send_edited', 'reply_myself', 'snooze', 'dismiss', 'cancel_lookup', 'undo_auto_reply',
];

const CHECK_MARKS: Record<ChannelLookupCheckStatus, ChannelCheckMark> = { pass: '✓', weak: '△', fail: '✗' };

// 授权表的结论（engine 的 channels/authority.ts）和 Lead 的决定（落地计划 B）。
const AUTHORITY_WORDS: Record<ChannelAuthorityActionKind, string> = {
  skip: '不打扰你', react: '回了表情', refuse: '代你拒绝', remind: '提醒你', closing_reply: '代你说一句', work: '要干活', ask: '问你',
  tell: '告诉你',
};
const LEAD_WORDS: Record<ChannelLeadDecision, string> = {
  dispatch: 'Lead 派了工单', answer: 'Lead 写了草稿', push: 'Lead 推送给你', told: 'Lead 已经告诉你',
  superseded: '并进了新消息的请求', closed: '卡已经结束',
  react: 'Lead 回了表情', refuse: 'Lead 用固定的话拒绝了', no_reply: 'Lead 判断不用回',
};

// 结果超过多久算旧（和 channel.reply 的 maxResultAgeMs 缺省值一样，spec D2）。
export const CHANNEL_LOOKUP_STALE_MS = 30 * 60_000;

/**
 * 草稿旁边的小字：直接回复时 hub 加的署名（spec D8，engine 的 disclosure.ts：「<助手名> (Assistant) · confirmed by <主人名>」）。
 * 助手名在 daemon 的配置里，卡的 DTO 没有它，这里不写出来。主人名来自代查的 DTO；没有代查的卡取不到，就不写名字。
 */
export function channelDraftDisclosure(ownerName: string | null): string {
  const name = ownerName?.trim();
  return name ? `直接回复时，开头会加一行助手的署名：confirmed by ${name}` : '直接回复时，开头会加一行助手的署名，写明是你确认发出的';
}
// 发出时会加「confirmed by」署名的草稿：代查写的、子 agent 工单写的、Lead 写的，旧卡上按对话起草的（spec D8，hub 的 ASSISTANT_DRAFTERS）。
const DISCLOSED_DRAFTERS: ReadonlySet<string> = new Set(['lookup', 'agent', 'lead', 'model']);
/** 「改一下再发」的输入框下面的小字（spec D8：用户改过的文字是用户自己的话）。 */
export const CHANNEL_EDITED_DISCLOSURE = '改过的文字按你写的原样发出，不加助手的署名';

// 本地时间的「HH:MM」。
export function clockWords(at: string | null): string | null {
  if (!at) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const fixed = (value: number) => value.toFixed(2);
// 样本数按标签的权重加起来，可能有一位小数（0.5）。
const count = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

// 「45 分钟前」「3 小时前」「2 天前」。
function agoWords(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function gateNote(card: ChannelCardDto): string | null {
  const gate = card.gate;
  if (!gate) return null;
  const category = gate.category ? CATEGORY_WORDS[gate.category] ?? gate.category : null;
  if (gate.decision === 'pending') return '正在判断能不能代你回复';
  if (gate.decision === 'shadow') return `影子模式：「${category}」这一类还没开放自动代回，草稿留给你决定`;
  if (gate.decision === 'denied') return gate.reasons.length ? `没有代你回复：${gate.reasons[0]}` : '没有代你回复';
  return null;
}

function buttonsFor(card: ChannelCardDto): ChannelCardButton[] {
  const lookup = card.lookup;
  const words = lookup?.playbook === 'review' ? REVIEW_BUTTON_LABELS : lookup ? LOOKUP_BUTTON_LABELS : {};
  return BUTTON_ORDER.filter((action) => card.actions.includes(action))
    .map((action) => ({ action, label: words[action] ?? BUTTON_LABELS[action], primary: action === 'send_draft' }));
}

// 「2 处出处已核实」「1/2 处出处已核实」「没有出处」。
function sourcesWords(sources: ReadonlyArray<{ verified?: boolean }>): string {
  if (!sources.length) return '没有出处';
  const verified = sources.filter((source) => source.verified === true).length;
  return verified === sources.length ? `${verified} 处出处已核实` : `${verified}/${sources.length} 处出处已核实`;
}

function lookupTrack(lookup: ChannelLookupDto): ChannelLookupTrackView {
  const finished = clockWords(lookup.finishedAt);
  let mark: string;
  let tone: ChannelCardTone;
  let status: string | null;
  let details: string[] = [];
  let reasons: string[] = [];
  switch (lookup.state) {
    case 'queued':
      [mark, tone, status] = ['…', 'accent', '排队中'];
      details = ['同时进行的代查满了，空出来就开始'];
      break;
    case 'running':
      [mark, tone, status] = ['…', 'accent', '进行中'];
      details = clockWords(lookup.startedAt) ? [`${clockWords(lookup.startedAt)} 开始`] : [];
      break;
    case 'finished': {
      const result = lookup.result;
      if (!result) {
        [mark, tone, status] = ['✓', 'neutral', '结束了'];
        details = finished ? [`${finished} 结束`] : [];
      } else if (result.found === 'no') {
        [mark, tone, status] = ['✗', 'warning', '没查到'];
        details = [...(finished ? [`${finished} 查完`] : []), `查过 ${result.checked.length} 处`];
      } else {
        [mark, tone, status] = result.found === 'yes' ? ['✓', 'success', null] : ['△', 'warning', '部分查到'];
        details = [...(finished ? [`完成于 ${finished}`] : []), sourcesWords([...result.sources, ...result.connectionSources])];
      }
      break;
    }
    case 'failed':
      [mark, tone, status] = ['✗', 'warning', '没做成'];
      details = finished ? [finished] : [];
      reasons = lookup.error ? [lookup.error] : [];
      break;
    case 'cancelled':
      [mark, tone, status] = ['–', 'muted', '已停止'];
      details = finished ? [finished] : [];
      break;
    case 'denied':
      [mark, tone, status] = ['✗', 'muted', '没有查'];
      reasons = lookup.deniedReasons;
      break;
  }
  // 「✓ 工单 #482 · 查到于 14:32 · 2 处出处已核实」「△ 部分查到 · 工单 #482 · ……」。
  const rest = [...(lookup.ticketId ? [`工单 #${lookup.ticketId}`] : []), ...details];
  const text = status ? [`${mark} ${status}`, ...rest].join(' · ') : `${mark} ${rest.join(' · ')}`.trim();
  return { mark, tone, status, ticketId: lookup.ticketId, details, text, reasons };
}

type ScorePanel = {
  decision: 'auto_send' | 'ask_user' | 'hand_over';
  audit: boolean;
  raw: number | null;
  confidence: number | null;
  threshold: number | null;
  calibration: { samples: number; agreed: number; minSamples: number } | null;
  checks: ReadonlyArray<{ label: string; status: ChannelLookupCheckStatus; value: number | null; detail: string }>;
  vetoes: string[];
  reasons: string[];
};

// 代回轨的一份分数：卡上的分数面板（handling.reply），或者旧的代查记录里的结论和检查。
// why：交给你时说明为什么（工单没做成、被停掉、没查到）。
function scoreTrack(card: ChannelCardDto, score: ScorePanel, now: Date, why: string): ChannelReplyTrackView {
  const checks: ChannelReplyCheckView[] = score.checks.map((check) => ({
    label: check.label, mark: CHECK_MARKS[check.status], status: check.status,
    value: check.value === null ? null : fixed(check.value), detail: check.detail,
  }));
  const calibration = score.calibration;
  const history = calibration
    ? calibration.samples < calibration.minSamples
      ? `这一段历史 ${count(calibration.samples)}/${calibration.minSamples}`
      : `这一段历史 照发 ${count(calibration.agreed)}/${count(calibration.samples)}`
    : null;
  // 校准把信心拉开了时写出校准以前的分（落地计划 D2）。
  const before = score.raw !== null && score.confidence !== null && Math.abs(score.raw - score.confidence) >= 0.005
    ? `校准前 ${fixed(score.raw)}` : null;
  const bounds = [before, score.threshold === null ? null : `自动门槛 ${fixed(score.threshold)}`].filter(Boolean).join('，');
  const value = score.confidence === null ? '信心算不出' : `信心 ${fixed(score.confidence)}`;
  const line = (status: string) => [status, ...(score.audit ? ['抽查'] : []), `${value}${bounds ? `（${bounds}）` : ''}`].join(' · ');
  const base = {
    checks, history, vetoes: score.vetoes, audit: score.audit, reasons: score.reasons.filter((reason) => !score.vetoes.includes(reason)),
  };
  switch (score.decision) {
    case 'auto_send': {
      if (card.state !== 'auto_replied') {
        // 自动回复撤回了，或者还没发出去（出站在重试）：卡回到等你处理。
        return { ...base, status: '自动回复没有生效', tone: 'warning', text: line('自动回复没有生效') };
      }
      const until = card.revokeUntil && Date.parse(card.revokeUntil) > now.getTime() ? clockWords(card.revokeUntil) : null;
      return {
        ...base, status: '已自动回复', tone: 'success',
        text: [line('已自动回复'), ...(until ? [`${until} 前可以撤回`] : [])].join(' · '),
      };
    }
    case 'ask_user':
      return { ...base, status: '问你', tone: 'accent', text: line('问你') };
    case 'hand_over':
      // 没查到、失败或被停：没有信心可算，检查明细也没有意义；原因写一次。
      return { ...base, checks: [], history: null, status: '交给你', tone: 'neutral', text: `交给你 · ${why}` };
  }
}

/** 代回轨：卡上这份草稿的分数面板优先；没有时按工单（旧的代查）记录里的结论。 */
function replyTrack(card: ChannelCardDto, now: Date): ChannelReplyTrackView | null {
  const lookup = card.lookup;
  const why = lookup?.state === 'failed' ? '工单没做成' : lookup?.state === 'cancelled' ? '工单被停掉了' : '没查到';
  const scored = card.handling?.reply;
  if (scored) return scoreTrack(card, scored, now, why);
  if (!lookup) return null;
  const reply = lookup.reply;
  const confidence = lookup.confidence;
  if (!reply) {
    const waiting = { audit: false, checks: [], history: null, vetoes: [], reasons: [] };
    if (lookup.state === 'queued' || lookup.state === 'running') return { ...waiting, status: '等工单结束再定', tone: 'muted', text: '等工单结束再定' };
    if (lookup.state === 'finished' || lookup.state === 'failed') return { ...waiting, status: '核对中', tone: 'muted', text: '核对中' };
    // 被拒、停了：不会有代回的判断，卡上由你决定。
    return null;
  }
  return scoreTrack(card, {
    decision: reply.decision, audit: false, raw: null, confidence: confidence?.value ?? null, threshold: confidence?.threshold ?? null,
    calibration: confidence?.calibration ?? null, checks: confidence?.checks ?? [], vetoes: confidence?.vetoes ?? [], reasons: reply.reasons,
  }, now, why);
}

/**
 * 处理轨：授权表的结论，交给 Lead 以后的决定，Lead 推送或者告诉你时写的话。通道没有判断过的旧卡是 null。
 * Lead 还没处理时写「排队中」：没有期限，系统不替 Lead 定（统一消息事件工单 06）。
 */
function handlingView(card: ChannelCardDto): ChannelHandlingView | null {
  const handling = card.handling;
  if (!handling || (!handling.authority && !handling.lead && !handling.ruleChange)) return null;
  const authority = handling.authority;
  const parts = authority
    ? [...(authority.intent ? [CHANNEL_INTENT_LABELS[authority.intent]] : []), AUTHORITY_WORDS[authority.action]]
    : [];
  const lead = handling.lead;
  let tone: ChannelCardTone = 'neutral';
  let note: string | null = null;
  let reason: string | null = null;
  if (lead && lead.decision === null) {
    // 还在排队等 Lead：要干活、要打扰你的先交给 Lead（intake）；信心模型说问你、交给你的交回 Lead（reply）。
    parts.push(lead.stage === 'reply' ? '交回 Lead，排队等它决定怎么告诉你' : '排队中，等 Lead 处理');
    tone = 'accent';
  } else if (lead?.decision) {
    parts.push(LEAD_WORDS[lead.decision]);
    if (lead.note && lead.by === 'lead' && (lead.decision === 'push' || lead.decision === 'told')) note = `Lead：${lead.note}`;
    else if (lead.note && lead.by === 'system') reason = lead.note;
  }
  const ruleChange = handling.ruleChange ? channelRuleChangeNotice(handling.ruleChange.kinds) : null;
  return { text: parts.join(' · '), tone, note, reason, ruleChange };
}

function staleWords(lookup: ChannelLookupDto, now: Date): string | null {
  const parts: string[] = [];
  if (lookup.newerMessages > 0) parts.push(`之后又来了 ${lookup.newerMessages} 条消息`);
  const finishedAt = lookup.finishedAt ? Date.parse(lookup.finishedAt) : Number.NaN;
  if (lookup.result && Number.isFinite(finishedAt) && now.getTime() - finishedAt >= CHANNEL_LOOKUP_STALE_MS) {
    parts.push(`结果是 ${agoWords(now.getTime() - finishedAt)}的`);
  }
  return parts.length ? parts.join('，') : null;
}

function readWords(record: ChannelLookupDto['reads']['items'][number]): string {
  const lines = record.lines ? `:${record.lines[0]}-${record.lines[1]}` : '';
  const where = record.path ? `${record.repo} ${record.path}${lines}` : record.repo;
  return `${record.tool} ${where}${record.refused ? ` · 被拒：${record.refused}` : ''}`;
}

/** 卡上的代查（两条轨道和可以展开的部分）。卡结束以后过时提示不再显示。 */
export function channelLookupView(card: ChannelCardDto, lookup: ChannelLookupDto, now: Date, closed: boolean): ChannelLookupView {
  const result = lookup.result;
  return {
    active: lookup.state === 'queued' || lookup.state === 'running',
    track: lookupTrack(lookup),
    actions: (result?.actions ?? []).filter((action) => action.visible).map((action) => ({ text: action.summary, url: action.url })),
    stale: closed ? null : staleWords(lookup, now),
    audience: {
      text: `谁能看到回复：${lookup.audience.label}${lookup.audience.externalShared ? ' · 和外部组织共享的对话' : ''}`,
      external: lookup.audience.externalShared,
    },
    reviewSummary: lookup.review?.summary.trim() || null,
    answer: result?.answer.trim() || null,
    sources: [
      ...(result?.sources ?? []).map((source) => ({
        verified: source.verified === true,
        where: `${source.repo} · ${source.path}:${source.startLine}-${source.endLine}`,
        quote: source.quote,
      })),
      // 引用连接查询结果的出处（例如 CDP）：哪个连接、哪个工具。
      ...(result?.connectionSources ?? []).map((source) => ({
        verified: source.verified === true, where: `${source.connection} · ${source.tool}`, quote: source.quote,
      })),
    ],
    checked: result?.checked ?? [],
    checkedVisible: result?.found === 'no',
    caveats: result?.caveats ?? [],
    comments: lookup.review
      ? {
        count: lookup.review.commentCount,
        items: lookup.review.comments.map((comment) => ({ where: `${comment.path}:${comment.line}`, body: comment.body })),
      }
      : null,
    reads: lookup.reads.count > 0
      ? { count: lookup.reads.count, items: lookup.reads.items.map(readWords), partial: lookup.reads.items.length < lookup.reads.count }
      : null,
  };
}

export function channelCardView(card: ChannelCardDto, now: Date = new Date()): ChannelCardView {
  const trust = TRUST_WORDS[card.sender.trust];
  const lookup = card.lookup;
  const buttons = buttonsFor(card);
  const base = {
    context: `${card.sourceLabel} · ${card.laneLabel}`,
    sender: trust ? `${card.sender.name}（${trust}）` : card.sender.name,
    excerpt: card.excerpt,
    more: card.messageCount > 1 ? `共 ${card.messageCount} 条消息` : null,
    compact: card.delivery === 'digest',
  };
  const open = (badge: ChannelCardView['badge'], note: string | null) => {
    const draft = card.draft?.text ?? null;
    return {
      ...base, draft, // 助手写的草稿（代查、Lead、子 agent）发出时加「confirmed by」署名（hub 的 send_draft）；旧卡上的模板草稿原样发。
      disclosure: draft && card.actions.includes('send_draft') && DISCLOSED_DRAFTERS.has(card.draft?.drafter ?? '')
        ? channelDraftDisclosure(card.lookup?.ownerName ?? null) : null,
      note, badge, buttons, closed: false,
    };
  };
  const ended = (badge: ChannelCardView['badge'], note: string, endButtons: ChannelCardButton[] = []) => ({
    ...base, draft: null, disclosure: null, note, badge, buttons: endButtons, closed: true,
  });
  let view: Omit<ChannelCardView, 'handling' | 'lookup' | 'reply' | 'folded'>;
  switch (card.state) {
    case 'open': {
      // 工单还没结束时，卡上写「进行中」；代回的判断在代回轨上。通道判断过的卡不再写模板闸门的话。
      // Lead 还没处理时写「排队中」，卡上没有草稿（统一消息事件工单 06：草稿只由 Lead 写，不放占位句）。
      const active = lookup?.state === 'queued' || lookup?.state === 'running';
      const queued = card.handling?.lead?.decision === null;
      view = open(active ? { label: '进行中', tone: 'accent' } : queued ? { label: '排队中', tone: 'accent' } : { label: '等你处理', tone: 'accent' },
        lookup || card.handling ? null : gateNote(card));
      break;
    }
    case 'snoozed':
      view = open({ label: '稍后', tone: 'neutral' }, `${clockWords(card.snoozedUntil) ?? '稍后'} 再提醒你`);
      break;
    case 'replying_self':
      // 你在来源里回过一句，但没回答对方（例如只说了收到）：卡还开着，不再推送。
      view = open({ label: '你回过一句', tone: 'neutral' }, `你在 ${card.sourceLabel} 里回过一句，还没回答对方`);
      break;
    case 'replied': {
      // Lead 照你的话在这个对话里发的消息（2026-10-26）：卡跟着结束，写明是代你发的。
      const how = card.outcome?.by === 'lead' ? '已代你回复' : '你用草稿回复了';
      view = ended({ label: '已回复', tone: 'success' }, card.sentText ? `${how}：「${card.sentText}」` : how);
      break;
    }
    case 'auto_replied': {
      const until = card.revokeUntil && Date.parse(card.revokeUntil) > now.getTime() ? clockWords(card.revokeUntil) : null;
      const how = lookup ? '已代你回复' : '已按常设指令代你回复';
      view = ended(
        { label: '已代你回复', tone: 'success' }, `${how}「${card.sentText ?? ''}」${until ? `，${until} 前可以撤回` : ''}`, buttons,
      );
      break;
    }
    case 'resolved_elsewhere':
      view = ended({ label: '已在别处处理', tone: 'muted' }, `你已在 ${card.sourceLabel} 里自己回复，不再提醒`);
      break;
    case 'dismissed':
      view = ended({ label: '不回', tone: 'muted' }, '你选了不回');
      break;
    case 'handled':
      view = ended({ label: '已处理', tone: 'success' }, card.outcome?.note ? `已照你的话处理：${card.outcome.note}` : '已照你的话处理');
      break;
    case 'left_to_user':
      view = ended({ label: '你自己回', tone: 'muted' }, '你说会自己回复');
      break;
  }
  const folded = view.closed && !view.buttons.length
    ? {
      who: `${card.sender.name}：${oneLine(card.excerpt)}`,
      outcome: [clockWords(card.resolvedAt ?? card.updatedAt), view.badge.label].filter(Boolean).join(' '),
    }
    : null;
  return {
    ...view, handling: handlingView(card), lookup: lookup ? channelLookupView(card, lookup, now, view.closed) : null,
    reply: replyTrack(card, now), folded,
  };
}
