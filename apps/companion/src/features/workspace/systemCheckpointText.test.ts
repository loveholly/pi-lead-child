// 复核 P1-10：#66 的进展记录里，系统写的「Run started」「Run crashed」是英文。显示时换成中文，报错原文不动。
import { describe, expect, it } from 'vitest';

import { systemCheckpointText } from './systemCheckpointText';

describe('system checkpoint text', () => {
  it('writes a run start in Chinese with the agent name and the model', () => {
    expect(systemCheckpointText({ source: 'system_derived', title: 'Run started', summary: 'codex run #74 started with gpt-5.5.' }))
      .toEqual({ title: 'Run #74 开始', summary: 'Codex 开始了 Run #74，模型 gpt-5.5。' });
    expect(systemCheckpointText({ source: 'system_derived', title: 'Run started', summary: 'claude run #49 started.' }))
      .toEqual({ title: 'Run #49 开始', summary: 'Claude Code 开始了 Run #49。' });
  });

  it('writes a crash in Chinese and keeps the raw error', () => {
    const error = 'No conversation found with session ID: 20fd5938-01a7-42ce-b4b4-bb1a98831c80';
    expect(systemCheckpointText({
      source: 'system_derived', title: 'Run crashed', summary: `Run #71 crashed (claude_error_during_execution): ${error}`,
    })).toEqual({ title: 'Run #71 失败', summary: `Run #71 失败（claude_error_during_execution）：${error}` });
  });

  it('leaves agent records and other system records as they are', () => {
    const agent = { source: 'agent_reported', title: 'Run started', summary: 'codex run #74 started.' };
    expect(systemCheckpointText(agent)).toEqual({ title: 'Run started', summary: 'codex run #74 started.' });
    const other = { source: 'system_derived', title: 'Codex 不支持该模型', summary: 'Codex · Run #73 · …' };
    expect(systemCheckpointText(other)).toEqual({ title: 'Codex 不支持该模型', summary: 'Codex · Run #73 · …' });
  });
});
