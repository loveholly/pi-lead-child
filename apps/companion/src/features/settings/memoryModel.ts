// 设置页「记忆」和「模型」的纯规则：现状怎样说、下载进度怎样写、数据会去哪里、表单怎样检查。
// 契约在 packages/protocol/src/memory.ts。
import {
  CORE_MEMORY_CONTENT_MAX, CORE_MEMORY_TITLE_MAX, isPlaintextServiceUrl, SERVICE_URL_MESSAGES, serviceUrlProblem,
  type CoreMemoryEntryDto, type CoreMemoryUpdateRequest, type MemoryBankStatsDto, type MemoryDataFlow, type MemoryDownload, type MemoryInvalidatedFactDto,
  type MemoryPreferencesDto, type MemorySettingsDto, type MemoryWritesDto, type SummaryModelSlot, type SummaryModelSlotDto,
} from '@pi-lead-child/protocol';

import { leadNameNow } from '@/state/leadName';

import { shortTime } from './standingOrderModel';

// leadName 是 Lead 的名字（useLeadName）。
export function memoryDescription(leadName: string): string {
  return `${leadName} 的笔记存在这台 Mac 的账本里。语义检索让它按意思找到相关的笔记，不只按字面。`;
}
export const MEMORY_RELOAD_NOTE = '改这里的设置只重启记忆服务，不打断对话和正在跑的工单。';
// 设置页没有「关闭」：没选 embedding 时，配过的远程照样在用（用户的决定）。只用全文检索要在 daemon 上设环境变量。
export const MEMORY_OFF_NOTE = '这里没有「关闭」。要只用全文检索，在 daemon 的环境里设 PLC_MEMORY_BACKEND=sqlite，再重启 daemon。';
export function modelDescription(leadName: string): string {
  return `${leadName} 用两类模型：大脑负责思考和对话，直觉负责快速打分和排序。每类一个主用，出问题时按顺序换到备用。key 只保存在这台 Mac 上。`;
}

export type StatusTone = 'success' | 'warning' | 'danger' | 'muted';

// 记忆服务没在跑（service.state 是 off）的原因。daemon 用 PLC_MEMORY_BACKEND=sqlite 关掉了记忆时，service.backend 是 sqlite；
// 否则按 embedding 的设置判断。uv 没装这类原因只有 daemon 知道，在 service.message 里。
// 现状卡、重排的说明和回退卡都用它，同一页上的说法才不会互相矛盾（例如一处说「先选」，另一处说「已选 · 下载好后切换」）。
export type MemoryOffReason = 'sqlite' | 'choose' | 'download' | 'download_failed' | 'waiting';

export function memoryOffReason(memory: MemorySettingsDto): MemoryOffReason | null {
  if (memory.service.state !== 'off') return null;
  if (memory.service.backend === 'sqlite') return 'sqlite';
  const { embedding } = memory;
  if (embedding.mode === 'unset' && !embedding.remote.baseUrl) return 'choose';
  if (embedding.mode === 'local' && embedding.local.download.state === 'failed') return 'download_failed';
  if (embedding.mode === 'local' && embedding.local.download.state !== 'ready') return 'download';
  return 'waiting';
}

const OFF_TEXTS: Record<MemoryOffReason, { status: string; rerank: string; fallback: string }> = {
  sqlite: {
    status: '这台 Mac 上关掉了语义检索（daemon 的环境里设了 PLC_MEMORY_BACKEND=sqlite），记忆只用全文检索。',
    rerank: '这台 Mac 上关掉了记忆（PLC_MEMORY_BACKEND=sqlite），现在不重排，也不往外发。',
    fallback: '这台 Mac 上关掉了记忆（PLC_MEMORY_BACKEND=sqlite），重排不用。要打开，去掉这个环境变量，再重启 daemon。',
  },
  choose: {
    status: '现在记忆只用全文检索：要字面上对得上才找得到。选一个 embedding 就能按意思找。',
    rerank: '记忆还没开始工作：先选 embedding。之后要往外发时，会先问你。',
    fallback: '先选 embedding，记忆才会开始工作。重排也从那时开始。',
  },
  download: {
    status: '现在记忆只用全文检索。本地模型下载好以后，开始按意思找。',
    rerank: '记忆还没开始工作：等本地模型下载好。之后要往外发时，会先问你。',
    fallback: '本地模型下载好以后，记忆才开始工作。重排也从那时开始。',
  },
  download_failed: {
    status: '现在记忆只用全文检索：本地模型下载失败。重试下载，或者改用远程。',
    rerank: '记忆还没开始工作：本地模型下载失败。之后要往外发时，会先问你。',
    fallback: '本地模型下载失败，记忆还没开始工作。重试下载，或者改用远程。',
  },
  waiting: {
    status: '现在记忆只用全文检索。embedding 就绪以后，开始按意思找。',
    rerank: '记忆还没开始工作：等 embedding 就绪。之后要往外发时，会先问你。',
    fallback: 'embedding 就绪以后，记忆才开始工作。重排也从那时开始。',
  },
};

export function memoryStatus(memory: MemorySettingsDto): { title: string; detail: string; tone: StatusTone } {
  const { service } = memory;
  // service.index.indexed 是 Hindsight 写完的笔记条数（2026-10-29 起），不是同步游标。写入失败的原因在 service.message 里。
  const index = `已写入 ${service.index.indexed.toLocaleString('en-US')} / ${service.index.notes.toLocaleString('en-US')} 条笔记`;
  switch (service.state) {
    case 'healthy':
      return {
        title: `语义检索已开${service.embedding ? ` · ${service.embedding}` : ''}`,
        detail: service.message ? `${index} · ${service.message}` : index,
        tone: 'success',
      };
    case 'starting':
      return { title: '记忆服务正在启动', detail: service.message ?? '启动以后会接着写入笔记。', tone: 'warning' };
    case 'down':
      return { title: '记忆服务停了', detail: service.message ?? '按意思检索暂时不可用，全文检索照常。', tone: 'danger' };
    case 'off':
    default:
      return {
        title: '语义检索没有开',
        detail: service.backend !== 'sqlite' && service.message
          ? `现在记忆只用全文检索：${service.message}`
          : OFF_TEXTS[memoryOffReason(memory) ?? 'choose'].status,
        tone: 'muted',
      };
  }
}

// 一个待确认的切换：要你点「切换」或「先不切换」。只有 needsConfirmation 的才算要你处理。
export function memoryNeedsUser(memory: MemorySettingsDto | null | undefined): boolean {
  return Boolean(memory?.pendingSwitch && memory.pendingSwitch.state === 'pending' && memory.pendingSwitch.needsConfirmation);
}

// 待确认的切换是不是压着 embedding：parts 里有 embedding 时，选的 embedding 要等用户确认才生效。
// 只差外部重排（parts 是 ["reranker"]）时，embedding 已经生效。
export function embeddingWaits(memory: MemorySettingsDto): boolean {
  const pending = memory.pendingSwitch;
  return Boolean(pending && pending.state === 'pending' && pending.parts.includes('embedding'));
}

// 实际在用哪一个 embedding。选了本地但还没下好、或者 embedding 的切换还等你确认时，远程照旧在用。
export function embeddingInUse(memory: MemorySettingsDto): 'local' | 'remote' | null {
  const { embedding, service } = memory;
  if (service.state === 'off') return null;
  if (embedding.mode === 'local' && embedding.local.download.state === 'ready' && !embeddingWaits(memory)) return 'local';
  return embedding.remote.baseUrl ? 'remote' : null;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function downloadPercent(download: MemoryDownload): number {
  return download.total > 0 ? Math.round((download.bytes / download.total) * 100) : 0;
}

// 下载进度的一行字。idle 时返回 null（还没开始，什么都不写）。
export function downloadLabel(download: MemoryDownload): string | null {
  switch (download.state) {
    case 'downloading':
      return download.total > 0
        ? `已下载 ${formatBytes(download.bytes)} / ${formatBytes(download.total)} · 断网后会接着下`
        : `正在下载 ${formatBytes(download.bytes)} · 断网后会接着下`;
    case 'ready':
      return '已下载';
    case 'failed':
      return `下载失败${download.error ? `：${download.error}` : ''}`;
    case 'idle':
    default:
      return null;
  }
}

// 已知模型的大小，写在选项旁边。别的模型不写数字。
const KNOWN_SIZES: Record<string, string> = {
  'intfloat/multilingual-e5-large': '下载约 2.2 GB',
};

export function localEmbeddingHint(model: string): string {
  const size = KNOWN_SIZES[model];
  return `${size ? `${size}。` : ''}笔记不离开这台 Mac。`;
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export function remotePrivacyNote(baseUrl: string | null | undefined): string {
  const host = hostOf(baseUrl);
  return `远程 embedding 会把每一条笔记发给${host ? ` ${host} ` : '这个服务商'}生成向量，包括以后新写的笔记。`;
}

export const RERANKER_LABELS: Record<MemorySettingsDto['reranker']['mode'], string> = {
  decision: '决策模型（Jev）',
  local: '本地',
  none: '不用',
};

// 用决策模型重排时，什么会离开这台 Mac。maxCandidates 来自 daemon（reranker.external 或切换的 dataFlows）；没有时不写数字。
export function externalRerankNote(host: string, maxCandidates: number | null): string {
  return `每次召回会把查询和${maxCandidates !== null ? `最多 ${maxCandidates} 条` : ''}记忆片段发给 ${host}。`;
}

export const EXTERNAL_RERANK_STOP = '要停止，把重排改成「本地」或「不用」。';

// 一个切换新增的外发，一条一句。用户在切换卡上点「同意并切换」之前读到的就是这些句子。
export function dataFlowNote(flow: MemoryDataFlow): string {
  return flow.kind === 'rerank'
    ? externalRerankNote(flow.host, flow.maxCandidates)
    : `每一条笔记会发给 ${flow.host} 生成向量，包括以后新写的笔记。`;
}

// 待确认的切换里要开始的外部重排。没有时返回 null。
export function pendingRerankFlow(memory: MemorySettingsDto): MemoryDataFlow | null {
  const pending = memory.pendingSwitch;
  if (!pending || pending.state !== 'pending') return null;
  return pending.dataFlows.find((flow) => flow.kind === 'rerank') ?? null;
}

// 决策模型的现状，给重排的说明用。还没读到时是 null。
export type DecisionState = { host: string | null; apiKeySet: boolean } | null;

// 重排选项「决策模型」下面的那句话。外发要先经用户在切换卡上同意（daemon 按切换的 id 和主机检查），
// 所以这里只说现状：在发、等确认、为什么还没发，或者选了以后会先问。
export function decisionRerankDescription(memory: MemorySettingsDto, decision: DecisionState): string {
  const lead = '用决策模型给找到的记忆排序。';
  const { reranker } = memory;
  const host = decision?.host ?? null;
  if (reranker.mode !== 'decision') {
    return `${lead}选它以后，${host ? `会把查询和记忆片段发给 ${host}，` : ''}开始之前会先问你。`;
  }
  const pending = pendingRerankFlow(memory);
  if (pending) return `${lead}等你确认后才开始：${dataFlowNote(pending)}`;
  if (reranker.external && reranker.effective === 'decision') {
    return `${lead}${externalRerankNote(reranker.external.host, reranker.external.maxCandidates)}${EXTERNAL_RERANK_STOP}`;
  }
  return `${lead}${rerankIdleReason(memory, decision)}`;
}

// 选了决策模型却还没往外发的原因。记忆服务不跑时，daemon 实际用的重排总是「不用」：先说为什么不跑，不要说成没有 key。
function rerankIdleReason(memory: MemorySettingsDto, decision: DecisionState): string {
  const off = memoryOffReason(memory);
  if (off) return OFF_TEXTS[off].rerank;
  switch (memory.service.state) {
    case 'starting':
      return '记忆服务正在启动，现在不往外发。';
    case 'down':
      return '记忆服务停了，现在不往外发。';
    default:
      break;
  }
  if (decision && !decision.apiKeySet) return '现在不往外发：决策模型没有能用的 key。在「模型」里设置 key 以后，开始之前会先问你。';
  return '现在不往外发。';
}

// 选的和实际在用的不一样时，说清楚为什么。setUpKey 表示要去「模型」里设置 key。
// 不写的情况：一样时；在等用户同意外发时（最上面的切换卡已经说了）；记忆服务在启动或停了时（现状卡片已经说了）。
export function rerankerFallbackNote(memory: MemorySettingsDto, decision: DecisionState): { text: string; setUpKey: boolean } | null {
  const { reranker, service } = memory;
  if (reranker.mode === reranker.effective) return null;
  const off = memoryOffReason(memory);
  if (off) return { text: OFF_TEXTS[off].fallback, setUpKey: false };
  if (service.state !== 'healthy') return null;
  if (reranker.mode === 'decision') {
    if (pendingRerankFlow(memory) || !decision || decision.apiKeySet) return null;
    return { text: '决策模型没有能用的 key，现在按「不用」处理。在「模型」里设置 key 以后，开始之前会先问你。', setUpKey: true };
  }
  if (reranker.mode === 'local' && reranker.local.download.state !== 'ready') {
    return { text: `本地模型还没下载好，现在用「${RERANKER_LABELS[reranker.effective]}」。下载好后自动切换。`, setUpKey: false };
  }
  return null;
}

// 带 key 的服务地址（远程 embedding、决策模型）。规则和文字用 protocol 的 serviceUrlProblem，和 daemon 一样。
// 前面先查格式（和契约的 HttpUrlSchema 一样：非空、没有空白、最多 500 个字符），好给出准确的原因。
const MAX_URL_LENGTH = 500;

export function endpointProblem(input: string): string | null {
  const value = input.trim();
  if (!value) return '请填写地址。';
  if (/\s/.test(value)) return '地址里不能有空格。';
  if (value.length > MAX_URL_LENGTH) return `地址太长了，最多 ${MAX_URL_LENGTH} 个字符。`;
  const problem = serviceUrlProblem(value);
  return problem ? `${SERVICE_URL_MESSAGES[problem]}。` : null;
}

// http 地址、主机又不是本机时的提示：key 和内容明文传输。https 或本机地址时是 null。
export function plaintextNote(input: string): string | null {
  if (!isPlaintextServiceUrl(input)) return null;
  return `这个地址用 http://：key 和发给 ${hostOf(input.trim())} 的内容会明文经过网络。只在可信的内网里这样用。`;
}

// 存的 key 绑定在一个主机上（daemon 给的 apiKeyHost）。表单里换了主机：保存后 daemon 删掉旧 key，不会把它发给新主机。
// 没换主机，或者没有 key 时返回 null。
export function keyHostChange(apiKeyHost: string | null | undefined, formUrl: string, apiKeySet: boolean): { from: string; to: string } | null {
  if (!apiKeySet || !apiKeyHost) return null;
  const to = hostOf(formUrl.trim())?.toLowerCase() ?? null;
  return to && to !== apiKeyHost ? { from: apiKeyHost, to } : null;
}

// source 是 key 从哪来：Keychain 或环境变量里的 key（external）只发给它的主机，不会被删掉。
export function keyHostChangeNote(change: { from: string; to: string }, source: 'settings' | 'external' | null = 'settings'): string {
  return source === 'external'
    ? `地址换到了 ${change.to}。Keychain 里的 key 只发给 ${change.from}，不会发给新地址。${change.to} 要 key 的话，请粘贴它的 key。`
    : `地址换到了 ${change.to}。已保存的 key 属于 ${change.from}，不会发给新地址，保存后会被删掉。${change.to} 要 key 的话，请粘贴它的 key。`;
}

// 换了主机、又没粘贴新 key 时，保存成功以后说什么。
export function keyDroppedNote(change: { from: string; to: string }, source: 'settings' | 'external' | null = 'settings'): string {
  return source === 'external'
    ? `Keychain 里的 key 只发给 ${change.from}，不会发给 ${change.to}。`
    : `旧的 key 属于 ${change.from}，已经删掉。${change.to} 要 key 的话，请粘贴它的 key。`;
}

// daemon 存着 key，但它属于别的主机（例如手改了 config.json），所以不会发出去。没有这种情况时返回 null。
export function keyHostMismatchNote(apiKeyHost: string | null | undefined, baseUrl: string | null | undefined, apiKeySet: boolean): string | null {
  const host = hostOf(baseUrl)?.toLowerCase() ?? null;
  if (apiKeySet || !apiKeyHost || !host || apiKeyHost === host) return null;
  return `存的 key 属于 ${apiKeyHost}，不会发给 ${host}。请粘贴 ${host} 的 key。`;
}

// 远程 embedding 的表单。和契约的 schema 一致：模型不带空白，维度 1 到 8192 或者留空。
export type RemoteForm = { baseUrl: string; model: string; dimensions: string; apiKey: string };

export function remoteFormProblem(form: RemoteForm, apiKeySet: boolean): string | null {
  const urlProblem = endpointProblem(form.baseUrl);
  if (urlProblem) return urlProblem;
  if (!/^\S{1,128}$/.test(form.model.trim())) return '请填写模型名，不能带空格。';
  const dimensions = form.dimensions.trim();
  if (dimensions && !(/^\d+$/.test(dimensions) && Number(dimensions) >= 1 && Number(dimensions) <= 8192)) {
    return '维度要是 1 到 8192 之间的整数，或者留空。';
  }
  if (!apiKeySet && !form.apiKey.trim()) return '请粘贴 API key。';
  return null;
}

export function remoteRequest(form: RemoteForm) {
  const dimensions = form.dimensions.trim();
  return {
    mode: 'remote' as const,
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    dimensions: dimensions ? Number(dimensions) : null,
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
  };
}

export type DecisionForm = { baseUrl: string; model: string; apiKey: string };

export function decisionFormProblem(form: DecisionForm): string | null {
  const urlProblem = endpointProblem(form.baseUrl);
  if (urlProblem) return urlProblem;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(form.model.trim())) return '模型名只能有字母、数字、点、下划线和连字符。';
  return null;
}

// —— Hindsight 的摘要模型和写入（2026-10-29，.scratch/hindsight-primary-memory/spec.md D3、D13、D16）——

export const SUMMARY_SLOT_LABELS: Record<SummaryModelSlot, string> = { default: '缺省 · 提取事实', consolidation: '整理观察' };
export const SUMMARY_MODEL_RESTART_NOTE = '改了以后记忆服务会重启，约几秒，期间召回只用全文检索。';
export const HINDSIGHT_OFF_NOTE = '记忆后端现在不是 Hindsight。这里的选择会存下，启用 Hindsight 以后生效。';
const SUMMARY_ENV_NOTE = '环境变量 PLC_HINDSIGHT_LLM 盖住了这里的选择。去掉它并重启 daemon 以后，这里的选择才生效。';

// 一个槽的模型是怎样选出来的。写在格子的第二行，所以要短。
export function summarySourceLabel(slot: SummaryModelSlotDto): string {
  switch (slot.source) {
    case 'env': return '环境变量 PLC_HINDSIGHT_LLM';
    case 'settings': return '你选的';
    case 'auto': return '自动：最新的 haiku';
    case 'inherit': return '跟缺省一样';
    case 'none': return 'Hindsight 只召回，不提取新事实';
  }
}

// 格子下面的一句：选的模型用不了的原因，或者环境变量盖住了这里的选择。daemon 写的原因已经说了环境变量时，不再说一遍。
export function summarySlotNote(slot: SummaryModelSlotDto): string | null {
  if (slot.problem) return slot.problem;
  if (slot.source === 'env') return SUMMARY_ENV_NOTE;
  return null;
}

const count = (value: number) => value.toLocaleString('en-US');

// 笔记写进 Hindsight 的情况（D3）。
export function writesLabel(writes: MemoryWritesDto): string {
  return `写入：完成 ${count(writes.completed)}、处理中 ${count(writes.pending)}、失败 ${count(writes.failed)}`;
}

export function writesFailedNote(writes: MemoryWritesDto): string | null {
  if (writes.failed === 0) return null;
  const failed = `${count(writes.failed)} 条笔记没有写进 Hindsight。`;
  return writes.lastError ? `${failed}最近一次的原因：${writes.lastError}` : failed;
}

// 记忆库的统计（D13）。服务没在运行时 daemon 给 null，这时不写。
export function bankStatsLabel(stats: MemoryBankStatsDto | null): string | null {
  if (!stats) return null;
  const parts = [`事实 ${count(stats.facts)} 条`, `观察 ${count(stats.observations)} 条`];
  if (stats.pendingConsolidation > 0) parts.push(`${count(stats.pendingConsolidation)} 条事实还没整理`);
  return `记忆库：${parts.join(' · ')}`;
}

// —— 常驻偏好（2026-10-29，.scratch/hindsight-primary-memory/spec.md D15）——
// 界面上只叫「常驻偏好」，不分类别，也不出现「笔记」这类说法（用户 2026-10-29：「这里就是记忆偏好」）。

// leadName 是 Lead 的名字（useLeadName）。
export function preferencesHint(leadName: string): string {
  return `${leadName} 做每件事时都参考这些偏好。它发现和你最近说的话有出入时，会自己改，并在会话里告诉你。你可以撤销。`;
}

// 改了以后什么时候生效（P15.2）：常驻偏好在系统提示词里，下一次开新会话或压缩上下文时才换。
export function preferencesEffectNote(leadName: string): string {
  return `改动从 ${leadName} 下一次开新会话或压缩上下文时起生效。`;
}

export function preferencesEmptyNote(leadName: string): string {
  return `还没有常驻偏好。${leadName} 发现你长期的习惯和偏好时，会记在这里。`;
}

// 所有常驻偏好一共用了多少字。写满以后改动会被拒，所以写满时用文字说出来，不只靠颜色。
export function preferencesUsageLabel(preferences: Pick<MemoryPreferencesDto, 'used' | 'cap'>): string {
  const label = `已用 ${count(preferences.used)} / ${count(preferences.cap)} 字`;
  return preferences.cap > 0 && preferences.used >= preferences.cap ? `${label} · 写满了` : label;
}

export function preferencesFull(preferences: Pick<MemoryPreferencesDto, 'used' | 'cap'>): boolean {
  return preferences.cap > 0 && preferences.used >= preferences.cap;
}

// 一条最近一次是谁、在什么时候、怎样改的：「Fairy 改的 · 10-29 14:00」。没有改动记录（以前写的）时只写时间。
export function preferenceChangeLine(entry: CoreMemoryEntryDto, leadName: string): string {
  const change = entry.lastChange;
  if (!change) return `最后修改 · ${shortTime(entry.updatedAt)}`;
  // 名字后面空一格（「Fairy 改的」），「你改的」不空。
  const who = change.actor === 'lead' ? `${leadName} ` : '你';
  const what = change.undoOf !== null ? '撤销了上一次改动' : change.action === 'create' ? '加的' : change.action === 'update' ? '改的' : '删的';
  return `${who}${what} · ${shortTime(change.at)}`;
}

// Lead 改的写出依据。你自己在设置页改的，依据是系统的默认说法，不写。
export function preferenceReasonLine(entry: CoreMemoryEntryDto): string | null {
  const change = entry.lastChange;
  if (!change || change.actor !== 'lead' || !change.reason.trim()) return null;
  return `依据：${change.reason.trim()}`;
}

export type PreferenceForm = { title: string; content: string };

// 就地编辑的检查，和操作的输入一致：去掉前后空白以后不能是空的，标题最多 200 字，正文最多 4000 字。
export function preferenceFormProblem(form: PreferenceForm): string | null {
  const title = form.title.trim();
  const content = form.content.trim();
  if (!title) return '标题不能是空的。';
  if (!content) return '内容不能是空的。';
  if (title.length > CORE_MEMORY_TITLE_MAX) return `标题最多 ${count(CORE_MEMORY_TITLE_MAX)} 个字。`;
  if (content.length > CORE_MEMORY_CONTENT_MAX) return `内容最多 ${count(CORE_MEMORY_CONTENT_MAX)} 个字。`;
  return null;
}

// 操作的输入只带改了的字段。什么都没改时是 null。
export function preferenceUpdateInput(entry: Pick<CoreMemoryEntryDto, 'title' | 'content'>, form: PreferenceForm): CoreMemoryUpdateRequest | null {
  const title = form.title.trim();
  const content = form.content.trim();
  const input: CoreMemoryUpdateRequest = {
    ...(title !== entry.title ? { title } : {}),
    ...(content !== entry.content ? { content } : {}),
  };
  return Object.keys(input).length ? input : null;
}

// 删掉以后撤销用的改动编号：操作的结果是 {id, change: {id, …}, eventSeq}。读不到时是 null（这时不给「撤销」）。
export function changeIdOf(result: unknown): number | null {
  const change = (result as { change?: { id?: unknown } | null } | null)?.change;
  return typeof change?.id === 'number' && Number.isInteger(change.id) && change.id > 0 ? change.id : null;
}

// —— 失效的事实（2026-10-29，spec D5：「hindsight 的 invalidate 机制要有啊」）——

export const INVALIDATED_HINT = '这些事实现在不会被召回。恢复以后会重新召回。';

// 谁在什么时候让它失效的：「Fairy 让它失效 · 10-29 14:00」。
export function invalidatedFactLine(fact: MemoryInvalidatedFactDto, leadName: string): string {
  return `${fact.actor === 'lead' ? `${leadName} ` : '你'}让它失效 · ${shortTime(fact.at)}`;
}

// 它来自哪里：来源偏好的标题；外部对话整理来的写明。都不知道时是 null。
export function invalidatedFactSource(fact: MemoryInvalidatedFactDto): string | null {
  if (fact.note && fact.external) return `来自外部对话：${fact.note.title}`;
  if (fact.note) return `来自：${fact.note.title}`;
  return fact.external ? '来自外部对话' : null;
}

// 测试结果的一行字。
export function testResultLabel(result: { ok: boolean; message: string; latencyMs: number | null }): string {
  if (result.ok) return `可用${result.latencyMs !== null ? ` · ${result.latencyMs} ms` : ''}`;
  return result.message || '测试没有通过。';
}

// 网关校验请求体时回的英文说明。别的错误 daemon 已经写成中文。
const SERVER_MESSAGES: Record<string, string> = {
  'baseUrl, model or apiKey is invalid': '地址、模型名或 API key 的格式不对。',
  'the embedding or reranker settings are invalid': 'embedding 或重排的设置格式不对。',
  'switch id is malformed': '这个切换的编号不对。',
  'approve must be a boolean': '确认切换的请求格式不对。',
  // 客户端自己的两句。
  'device is not paired': '这台设备还没有配对。',
};
// 另一句客户端的话要写 Lead 的名字。错误文字离组件太远，读最近一次取到的名字（leadNameNow）。
const OLD_CLIENT_MESSAGE = 'this client cannot manage Lead memory';

export function memoryErrorText(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  if (message === OLD_CLIENT_MESSAGE) return `这个版本的客户端不能管理 ${leadNameNow()} 的记忆。`;
  return SERVER_MESSAGES[message] ?? (message || '请求没有完成，请再试一次。');
}
