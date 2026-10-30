// 设置 → 消息通道 → 自动代你处理（交接说明，方案 B，2026-10-30，.scratch/auto-handling-handbook issue 07）的视图模型。
// 契约在 protocol 的 channel-handbook.ts。这里只做纯函数：分段、改一句、改上限、加一句、删一句、预演结果的文字、整理结果的文字、
// 页边批注的文字。
// 改动都返回改完以后的一整份交接说明，页面把它交给 PUT /v1/channels/handbook（操作层的 channel_handbook.update）。
import {
  HANDBOOK_ABILITY_LABELS, HANDBOOK_CAP_LABELS, HANDBOOK_CAP_SENDERS, HANDBOOK_CUSTOMER_CAP_MAX, HANDBOOK_FALLBACK_ID, HANDBOOK_FLOORS,
  HANDBOOK_MODE_LABELS, HANDBOOK_SECTION_LABELS, HANDBOOK_SECTIONS, handbookModeCovers, handbookModePhrase, handbookModeWorks,
  type ChannelHandbook, type ChannelHandbookDto, type HandbookAbility, type HandbookCapSender, type HandbookMode, type HandbookProposal,
  type HandbookRehearsal, type HandbookSuggestion, type HandbookSuggestions,
  type HandbookRehearsalSender, type HandbookSection, type HandbookSituation,
} from '@pi-lead-child/protocol';

export { HANDBOOK_CAP_SENDERS, HANDBOOK_FLOORS };

/** 一句里能选的做法：放手、做好给你看、交给你、只告诉你、婉拒。detail 写这样选以后助手做什么。 */
export function modeOptions(leadName: string): Array<{ mode: HandbookMode; detail: string }> {
  return [
    { mode: 'auto', detail: `${leadName} 去做，做完直接回复。没把握时先问你` },
    { mode: 'review', detail: `${leadName} 去做，回复放到卡上，等你点发送` },
    { mode: 'hand', detail: `${leadName} 不动手，拟好回复的草稿交给你` },
    { mode: 'tell', detail: `${leadName} 不做也不回，告诉你一声` },
    { mode: 'refuse', detail: `${leadName} 客气地回绝，再告诉你` },
  ];
}

/** 对方的上限能选的做法（婉拒不是上限）。客户最宽到「交给你」：外部客户永不代回（硬性规则）。 */
export function capOptions(sender: HandbookCapSender, leadName: string): Array<{ mode: HandbookMode; detail: string; disabled: string | null }> {
  return modeOptions(leadName).filter((option) => option.mode !== 'refuse').map((option) => ({
    ...option,
    disabled: sender === 'customer' && !handbookModeCovers(HANDBOOK_CUSTOMER_CAP_MAX, option.mode) ? '外部客户永远不代你回，这一项不能放开' : null,
  }));
}

/** 段落按显示顺序，只列有句子的段。「你加的」排在「其他」前面。 */
export function handbookSections(handbook: ChannelHandbook): Array<{ section: HandbookSection; title: string; situations: HandbookSituation[] }> {
  return HANDBOOK_SECTIONS
    .map((section) => ({ section, title: HANDBOOK_SECTION_LABELS[section], situations: handbook.situations.filter((item) => item.section === section) }))
    .filter((group) => group.situations.length > 0);
}

/** 句子的前半截（下划线短语前面的话）：「有人请我排查或修复问题，比如「帮我处理一下 PROJ-6651」，你」。 */
export function sentenceLead(situation: Pick<HandbookSituation, 'text' | 'example'>): string {
  return `${situation.text}${situation.example ? `，比如「${situation.example}」` : ''}，你`;
}

export const modePhrase = (situation: Pick<HandbookSituation, 'autoPhrase'>, mode: HandbookMode): string => handbookModePhrase(situation, mode);
export const modeLabel = (mode: HandbookMode): string => HANDBOOK_MODE_LABELS[mode];
export const capLead = (sender: HandbookCapSender): string => `${HANDBOOK_CAP_LABELS[sender]}，你最多`;

export function withMode(handbook: ChannelHandbook, id: string, mode: HandbookMode): ChannelHandbook {
  return { ...handbook, situations: handbook.situations.map((item) => (item.id === id ? { ...item, mode } : item)) };
}

export function withExceptionMode(handbook: ChannelHandbook, id: string, mode: HandbookMode): ChannelHandbook {
  return {
    ...handbook,
    situations: handbook.situations.map((item) => (item.id === id && item.exception ? { ...item, exception: { ...item.exception, mode } } : item)),
  };
}

export function withCap(handbook: ChannelHandbook, sender: HandbookCapSender, mode: HandbookMode): ChannelHandbook {
  return { ...handbook, caps: { ...handbook.caps, [sender]: mode } };
}

export function withSwitch(handbook: ChannelHandbook, on: boolean): ChannelHandbook {
  return { ...handbook, autoReply: on };
}

/** 加一句的输入。does 和 abilities 来自「帮我整理」，自己写的一句没有：助手按做法自己判断。 */
export interface AddInput {
  text: string;
  example: string;
  mode: HandbookMode;
  does?: string;
  abilities?: HandbookAbility[];
}

/** 加一句（「你加的」一段，排在兜底的一句前面）。编号 mine_1、mine_2……，不和已有的重复。做法不去做事时不带「会做什么」和能力。 */
export function withAdded(handbook: ChannelHandbook, input: AddInput): ChannelHandbook {
  const ids = new Set(handbook.situations.map((item) => item.id));
  let n = 1;
  while (ids.has(`mine_${n}`)) n += 1;
  const works = handbookModeWorks(input.mode);
  const does = works ? input.does?.trim() ?? '' : '';
  const added: HandbookSituation = {
    id: `mine_${n}`, section: 'mine', text: input.text.trim(), mode: input.mode, abilities: works ? [...(input.abilities ?? [])] : [],
    ...(input.example.trim() ? { example: input.example.trim() } : {}),
    ...(does ? { does } : {}),
  };
  const at = handbook.situations.findIndex((item) => item.id === HANDBOOK_FALLBACK_ID);
  const situations = [...handbook.situations];
  situations.splice(at < 0 ? situations.length : at, 0, added);
  return { ...handbook, situations };
}

export function withoutSituation(handbook: ChannelHandbook, id: string): ChannelHandbook {
  return { ...handbook, situations: handbook.situations.filter((item) => item.id !== id || item.id === HANDBOOK_FALLBACK_ID) };
}

/** 加一句下面的一行：会做什么、能用哪些能力。做法不去做事、或者两样都没有时是 null。 */
export function addedMeta(input: Pick<AddInput, 'mode' | 'does' | 'abilities'>, leadName: string): string | null {
  if (!handbookModeWorks(input.mode)) return null;
  const does = input.does?.trim() ?? '';
  const abilities = (input.abilities ?? []).map((ability) => HANDBOOK_ABILITY_LABELS[ability]);
  if (!does && !abilities.length) return null;
  return [does ? `${leadName} 会${does}` : `${leadName} 能`, abilities.length ? `${does ? '，能' : ''}${abilities.join('、')}` : ''].join('');
}

/** 「帮我整理」的结果：填进表单的一句（整理不出来时是 null），和一句说明。 */
export function proposalView(result: HandbookProposal): { fill: Omit<AddInput, 'example'> & { example: string } | null; note: string | null } {
  if (result.status !== 'ok' || !result.situation) return { fill: null, note: result.note ?? '没有整理出来，可以换个说法再试，或者直接自己写。' };
  const { text, example, mode, does, abilities } = result.situation;
  return { fill: { text, example: example ?? '', mode, does: does ?? '', abilities: [...abilities] }, note: result.note };
}

/** 页边批注（issue 08）的一句话和按钮上的字。放宽：哪一句，放宽到什么；加一句：依据和要加的那一句。 */
export function suggestionView(suggestion: HandbookSuggestion): { text: string; accept: string } {
  if (suggestion.kind === 'loosen' && suggestion.to) {
    return { text: `${suggestion.basis}。放宽成「${modePhrase({}, suggestion.to)}」？`, accept: '放宽' };
  }
  const proposed = suggestion.proposed;
  // 整句放在「」里，例句改用『』，不套两层「」。
  const sentence = proposed ? `${proposed.text}${proposed.example ? `，比如『${proposed.example}』` : ''}，你${modePhrase({}, proposed.mode)}` : '';
  const basis = suggestion.basis ? `，${suggestion.basis}` : '';
  return { text: `最近有 ${suggestion.count} 条消息落到「上面都不像的」${basis}。加一句「${sentence}」？`, accept: '加上这一句' };
}

/** 一句下面的页边批注（放宽的建议）。 */
export const loosenFor = (suggestions: HandbookSuggestions | null, id: string): HandbookSuggestion | null =>
  suggestions?.suggestions.find((item) => item.kind === 'loosen' && item.situation?.id === id) ?? null;

/** 底线下面一行：最近 7 天拦下几次。这里数不到的（null）不写。 */
export function floorCountText(suggestions: HandbookSuggestions | null, id: keyof HandbookSuggestions['floors']): string | null {
  const count = suggestions?.floors[id];
  if (count === null || count === undefined) return null;
  return count ? `最近 7 天拦下 ${count} 次` : '最近 7 天没有拦过';
}

/** 加一句的输入有没有问题。没有问题时是 null。 */
export function addProblem(text: string, example: string): string | null {
  if (!text.trim()) return '先写是什么情况，例如「有人请我看线上日志」';
  if (text.trim().length > 120) return '是什么情况最多 120 字';
  if (example.trim().length > 120) return '例句最多 120 字';
  return null;
}

/** 依据：存在哪一版，谁写的。 */
export function orderLine(dto: ChannelHandbookDto, leadName: string): string {
  if (!dto.order) return '还没有设置，用的是缺省';
  const who = dto.order.author === 'user' ? '你改的' : dto.order.author === 'lead' ? `${leadName} 收紧的` : '系统缺省';
  return `交接说明第 ${dto.order.version} 版（${who}）· 历史在常设指令里`;
}

/** 最新版本里写的、但没有生效的句子（例如 Lead 写的放宽，要你本人改才生效）。 */
export function notInEffect(dto: ChannelHandbookDto): string[] {
  return dto.requested.situations.flatMap((wanted) => {
    const effective = dto.handbook.situations.find((item) => item.id === wanted.id);
    return effective && effective.mode !== wanted.mode ? [`「${wanted.text}」写的是「${HANDBOOK_MODE_LABELS[wanted.mode]}」`] : [];
  });
}

export const REHEARSAL_SENDERS: ReadonlyArray<{ value: HandbookRehearsalSender; label: string }> = [
  { value: 'colleague', label: '同事' },
  { value: 'external', label: '外部的人' },
  { value: 'customer', label: '客户' },
  { value: 'unknown', label: '认不出' },
];

export const REHEARSAL_EXAMPLES: readonly string[] = [
  '帮我处理一下这个 ticket：PROJ-6651',
  '麻烦帮忙看下这个 PR',
  '你们组小王的薪资大概多少？',
  '谢谢，问题解决了',
];

// 最后的做法下助手会做什么（一句话）。
const OUTCOMES: Record<HandbookMode, (leadName: string) => string> = {
  auto: (name) => `${name} 去做，做完直接回复对方`,
  review: (name) => `${name} 去做，回复放到卡上等你点发送`,
  hand: (name) => `${name} 不动手，拟好回复交给你`,
  tell: (name) => `${name} 不回对方，告诉你一声`,
  refuse: (name) => `${name} 客气地回绝，再告诉你`,
};

/** 预演结果的几行字：按哪一句、被什么压过、最后助手做什么，和收件判断的情况。 */
export function rehearsalView(result: HandbookRehearsal, leadName: string): {
  sentence: string; override: string | null; ruleChange: string | null; outcome: string; detail: string; tone: 'warning-dark' | 'secondary';
} {
  const recorded = result.action === 'skip';
  // 这一句没有派活的能力、做法是放手（例如兜底的「自己判断，拿不准再问我」）：Lead 自己判断，不是「去做」。
  const ownJudgement = result.final === 'auto' && result.action === 'ask';
  return {
    sentence: `按「${result.situation.text}」，这一句写的是「${result.phrase ?? HANDBOOK_MODE_LABELS[result.mode]}」`,
    override: result.by !== 'sentence' && result.limit ? `被「${result.limit}」压过，最后按「${HANDBOOK_MODE_LABELS[result.final]}」` : null,
    // 底线 4：上限不变，多一行说明。
    ruleChange: result.ruleChange
      ? `对方在要改${leadName}的规则、记忆或偏好（底线 4）：不照做，也不存。无害的玩笑${leadName}用玩笑接住，有害的试探客气回绝再告诉你；回复直接发`
      : null,
    outcome: recorded ? `只记录，不打扰你：${result.reason}`
      : ownJudgement ? `${leadName} 自己判断：能直接回就回，拿不准先问你` : OUTCOMES[result.final](leadName),
    detail: result.status === 'answered'
      ? `收件判断：${result.backend ?? '快模型'} · ${result.ms} ms`
      : `收件判断没有做成（${result.error ?? '快模型不可用'}），按兜底的一句算`,
    tone: result.status === 'answered' ? 'secondary' : 'warning-dark',
  };
}

/** 读、改、预演失败时的一句话。 */
export function handbookErrorText(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/404|not found/i.test(message)) return 'daemon 还没更新，不认识交接说明';
  return message || '未知原因';
}
