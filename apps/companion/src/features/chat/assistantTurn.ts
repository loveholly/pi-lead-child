import type { TaskCardStatus, TaskCardStep, TaskStepState } from '@pi-lead-child/components';

import { isLeadRestartInterruption } from '@pi-lead-child/protocol';

import type { MessageEntity, MessageFailure, MessagePart } from '../../state/types';

type ToolPart = Extract<MessagePart, { kind: 'tool' }>;

export type AssistantTurnCard = {
  status: TaskCardStatus;
  steps: TaskCardStep[];
  durationMs: number | null;
};

// 一轮助手回复在会话里的样子：
// - card：工作步骤，即工具调用和工具之间说的话。没有工具时没有卡片，只在什么都还没收到时显示 Thinking。
// - reply：最后一个工具之后说的话，紧接在卡片下面。结束在工具调用上的一轮没有这句话，就用卡片里最后一句话。
// - body：回复和 Lead 画的卡片（surface），按出现的先后排：卡片之前写的字在上面，之后写的字在下面（2026-10-24）。
//   Lead 多半先画卡、后写字；以前字总在卡片上面，越写越长，把卡片往下推，页面抖。现在页面只在底部长。
// - attachmentPartIds：工单、审批、产物这些附件，按事件的先后，放在回复下面（AssistantTurnView）。
// 只有还在流的一轮（streaming、queued）才转圈；结束了的（completed、failed、steered）没有 Thinking，
// 也没有「运行中」的一步：没收到结束事件的调用算没有完成（stopped）。
export type AssistantTurnBodyItem = { kind: 'text'; text: string } | { kind: 'part'; partId: string };

export type AssistantTurn = {
  card: AssistantTurnCard | null;
  body: AssistantTurnBodyItem[];
  attachmentPartIds: string[];
  reply: string;
};

// text 是整轮的回复（已落定的文字加上正在流的文字）。工具调用的 textOffset 说它开始时回复有多少字：
// 按它把回复切开，所以文字和工具的先后与事件一致。流的文字还没追上某个 offset 时，切在已有文字的末尾。
export function buildAssistantTurn({
  messageId, messageState, failure = null, text, parts, startedAt = null, endedAt = null, now = Date.now(),
}: {
  messageId: string;
  messageState: MessageEntity['state'];
  // 这一轮的失败。被 daemon 重启打断的不算失败（2026-10-16 决定 D3）：Lead 会接着回复，卡片不画成「未完成」。
  failure?: MessageFailure | null;
  text: string;
  parts: readonly MessagePart[];
  // 这一轮开始和结束的时间（消息的 createdAt、updatedAt：daemon 记的轮次时间，结束了的一轮最后一次改状态就是结束）。
  startedAt?: string | null;
  endedAt?: string | null;
  // 现在的时间（毫秒）。还在跑的一轮写已经过去多久。
  now?: number;
}): AssistantTurn {
  const active = messageState === 'streaming' || messageState === 'queued';
  // render_ui 画的是给用户看的卡片（surface 部件），不是工作步骤：不进任务卡，也不算进「N 个工具」。
  const tools = parts.filter((part): part is ToolPart => part.kind === 'tool' && part.name !== 'render_ui');
  const steps: TaskCardStep[] = [];
  let cursor = 0;
  for (const part of tools) {
    const offset = Math.min(Math.max(part.textOffset, cursor), text.length);
    const narration = text.slice(cursor, offset).trim();
    if (narration) steps.push({ kind: 'note', id: `${messageId}:note:${cursor}`, text: narration });
    steps.push(toolStep(part, active));
    cursor = offset;
  }
  let reply = text.slice(cursor).trim();
  let replyFromNote = false;
  if (!active && !reply) {
    let lastNote = steps.length - 1;
    while (lastNote >= 0 && steps[lastNote]!.kind !== 'note') lastNote -= 1;
    const note = lastNote >= 0 ? steps.splice(lastNote, 1)[0] : undefined;
    if (note?.kind === 'note') {
      reply = note.text;
      replyFromNote = true;
    }
  }
  const surfaces = parts
    .filter((part): part is Extract<MessagePart, { kind: 'surface' }> => part.kind === 'surface')
    .map((part, index) => ({ part, index }))
    .sort((left, right) => left.part.textOffset - right.part.textOffset || left.index - right.index)
    .map(({ part }) => part);
  const body: AssistantTurnBodyItem[] = [];
  const pushText = (value: string) => {
    if (value.trim()) body.push({ kind: 'text', text: value.trim() });
  };
  if (replyFromNote) {
    // 回复是从卡片里挪出来的最后一句话：它不在回复的位置上，卡片照旧放在它下面。
    pushText(reply);
    for (const part of surfaces) body.push({ kind: 'part', partId: part.id });
  } else {
    let at = cursor;
    for (const part of surfaces) {
      const offset = Math.min(Math.max(part.textOffset, at), text.length);
      pushText(text.slice(at, offset));
      body.push({ kind: 'part', partId: part.id });
      at = offset;
    }
    pushText(text.slice(at));
  }
  const attachmentPartIds = parts
    .filter((part) => part.kind !== 'text' && part.kind !== 'tool' && part.kind !== 'surface')
    .map((part) => part.id);
  const running = steps.some((step) => step.kind === 'tool' && step.state === 'running');
  const interrupted = isLeadRestartInterruption(failure?.message);
  const status: TaskCardStatus = messageState === 'failed' && !interrupted
    ? 'failed'
    : active
      ? running ? 'working' : 'thinking'
      : 'done';
  const waiting = active && !reply && attachmentPartIds.length === 0 && surfaces.length === 0;
  return {
    card: steps.length > 0 || waiting ? { status, steps, durationMs: turnSpan({ startedAt, endedAt, active, now }) } : null,
    body,
    attachmentPartIds,
    reply,
  };
}

// 结束了的一轮里没有收到结束事件的工具，算没有完成。
function toolStep(part: ToolPart, active: boolean): TaskCardStep {
  const state: TaskStepState = part.state === 'completed'
    ? 'done'
    : part.state === 'failed' ? 'failed' : active ? 'running' : 'stopped';
  return {
    kind: 'tool',
    id: part.id,
    name: part.name,
    state,
    args: part.args?.preview ?? null,
    result: part.result?.preview ?? null,
    error: part.error,
    truncated: Boolean(part.args?.truncated || part.result?.truncated),
  };
}

// 卡片的用时：这一轮从开始到结束（spec D9）。以前量的是第一个工具开始到最后一个工具结束：2026-10-16 那一轮
// 跑了 72 分钟（压缩跑了一个多小时），回合头写的是「3 秒」。还在跑的一轮量到现在。
// 两头都是 daemon 记的时间（轮次的 created_at、updated_at，或者实时事件的 occurredAt），刷新前后一样。
function turnSpan({ startedAt, endedAt, active, now }: {
  startedAt: string | null; endedAt: string | null; active: boolean; now: number;
}): number | null {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const end = active ? now : endedAt ? Date.parse(endedAt) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

// 这一轮回复的依据：见 ./provenance。
export { provenanceLabels } from './provenance';

