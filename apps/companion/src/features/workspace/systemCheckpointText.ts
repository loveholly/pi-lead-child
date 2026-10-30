// 系统自己写的两种进展记录是英文的：「Run started」和「Run crashed」（packages/engine 的 children/manager.ts）。
// 服务端的文字还有测试和 Lead 在读，这里只在显示时换成中文（复核 P1-10）。报错原文保持原样。
import { runtimeDisplayName } from './runtimeNames';

type SystemCheckpointText = { title: string; summary: string };

const RUN_STARTED = /^(\w+) run #(\d+) started(?: with (.+?))?\.$/;
const RUN_CRASHED = /^Run #(\d+) crashed \(([^)]*)\): ([\s\S]*)$/;

/** 系统记录的中文标题和说明。不认识的记录原样返回。 */
export function systemCheckpointText(checkpoint: { source: string; title: string; summary: string }): SystemCheckpointText {
  const { title, summary } = checkpoint;
  if (checkpoint.source !== 'system_derived') return { title, summary };
  if (title === 'Run started') {
    const match = RUN_STARTED.exec(summary.trim());
    if (!match) return { title: 'Run 开始', summary };
    const [, runtime, runId, model] = match;
    return {
      title: `Run #${runId} 开始`,
      summary: `${runtimeDisplayName(runtime) ?? runtime} 开始了 Run #${runId}${model ? `，模型 ${model}` : ''}。`,
    };
  }
  if (title === 'Run crashed') {
    const match = RUN_CRASHED.exec(summary.trim());
    if (!match) return { title: 'Run 失败', summary };
    const [, runId, code, error] = match;
    return { title: `Run #${runId} 失败`, summary: `Run #${runId} 失败（${code}）：${error}` };
  }
  return { title, summary };
}
