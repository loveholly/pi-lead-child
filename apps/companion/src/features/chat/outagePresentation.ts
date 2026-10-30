// 一次停摆在会话里的样子（2026-10-16）：一张系统卡片，开头一句，展开看积压的事。
// 卡片的材料是 daemon 的兜底通知（system:fallback-notice）和同一段时间里 Lead 那几轮失败的回合。
//   · daemon 新写的通知开头一行就是标题（"Lead 离线 19:11–20:07（网络中断）· 期间积压 1 件 · …"），下面每件一行；
//   · 旧的通知是"⏰ Lead 现在不可用：<原因>。积压了 N 件事：\n1. …"，每件照抄了 Lead 写给自己的话。
//     这里按同样的格式重写：时间取这些通知和失败的最早、恢复取后面第一次成功的 Lead 回答，积压的事改写给用户看。
import {
  classifyLeadModelError, isLeadOutageHeadline, leadModelFailureReason, leadOutageCause, leadOutageHeadline,
  userFacingBacklogText, type LeadModelFailureKind,
} from '@pi-lead-child/protocol';

import { leadNameNow } from '../../state/leadName';

export type OutagePresentation = {
  headline: string;
  // 展开以后的每一行：积压的事，以及 Lead 那几次没完成的处理。
  lines: string[];
};

const OLD_HEADLINE = /^Lead 现在不可用：(.*?)。积压了 (\d+) 件事：?$/u;

export function presentOutage(input: {
  notices: ReadonlyArray<{ text: string; at: string }>;
  failures: ReadonlyArray<{ raw: string; at: string }>;
  // 停摆以后第一次成功的 Lead 回答。没有就是还没恢复。
  recoveredAt: string | null;
  clock: (value: string) => string;
}): OutagePresentation {
  const { notices, failures, recoveredAt, clock } = input;
  // 称呼 Lead 用它的名字（设置 → 身份与风格）。daemon 写的标题里已经是写下时的名字。
  const name = leadNameNow();
  const failureKinds = failures.map((failure) => classifyLeadModelError(failure.raw));
  const failureLine = failures.length
    ? [`期间 ${name} 有 ${failures.length} 次自动处理没有完成（${leadModelFailureReason(dominantKind(failureKinds), name)}）`]
    : [];
  const latest = notices.at(-1);
  const latestLines = (latest?.text ?? '').replace(/^⏰\s*/u, '').split('\n').map((line) => line.trim()).filter(Boolean);
  // daemon 新写的通知：标题和每一行都已经是写给用户的。
  if (latestLines[0] && isLeadOutageHeadline(latestLines[0])) {
    return {
      headline: latestLines[0],
      lines: [...latestLines.slice(1).map((line) => line.replace(/^·\s*/u, '')), ...failureLine],
    };
  }
  // 旧的通知：从文字里读原因和件数，积压的事重写。
  const items: string[] = [];
  let reason = '';
  for (const notice of notices) {
    const [head = '', ...rest] = notice.text.replace(/^⏰\s*/u, '').split('\n').map((line) => line.trim()).filter(Boolean);
    const parsed = OLD_HEADLINE.exec(head);
    if (parsed) reason = parsed[1] ?? reason;
    // 认不出的格式：开头一行也是一件事，不丢。
    for (const line of parsed ? rest : [head, ...rest]) {
      const text = userFacingBacklogText(line.replace(/^\d+\.\s*/u, ''), name);
      if (text && !items.includes(text)) items.push(text);
    }
  }
  const kind = failureKinds.length ? dominantKind(failureKinds) : classifyLeadModelError(reason);
  const times = [...notices.map((notice) => notice.at), ...failures.map((failure) => failure.at)]
    .map((value) => Date.parse(value)).filter(Number.isFinite);
  const start = times.length ? new Date(Math.min(...times)).toISOString() : (latest?.at ?? '');
  return {
    headline: leadOutageHeadline({
      start: clock(start),
      end: recoveredAt ? clock(recoveredAt) : null,
      cause: leadOutageCause(kind),
      pending: items.length,
      resumed: false,
      durationMs: recoveredAt && start ? Date.parse(recoveredAt) - Date.parse(start) : null,
      name,
    }),
    lines: [...items, ...failureLine],
  };
}

// 几次失败里说明问题的那一种：有断网就是断网，其余取最多的一种。
function dominantKind(kinds: readonly LeadModelFailureKind[]): LeadModelFailureKind {
  if (kinds.includes('network')) return 'network';
  const counts = new Map<LeadModelFailureKind, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'unknown';
}
