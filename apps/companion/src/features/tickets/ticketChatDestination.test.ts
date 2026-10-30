// 2026-10-15 方案 A：工单线程的输入框说明写清楚现在是谁在跑、消息会去哪里。
// #66 那次：核查 Run（Codex）在跑，说明却写「发给 #66 的执行 agent · child #87 · 每条消息开一次对话 Run」，
// 消息发出去以后失败了。Codex 和 Claude Code 不能在 Run 中途接收消息，消息会排队，Run 结束后转交。
import { describe, expect, it } from 'vitest';

import { ticketChatDestination, tokenEstimateText } from './ticketChatStatus';

const run = (purpose: 'execution' | 'review' | 'conversation') => ({
  runId: 87, purpose, label: '核查 Run #87 · 正在核查', phase: 'running' as const, elapsedMs: 60_000, stalled: false,
});

describe('where a ticket message goes', () => {
  it('queues for a running Codex or Claude Code run and says so', () => {
    expect(ticketChatDestination({ ticketDisplayId: '66', liveRun: run('review'), runtimeName: 'codex' })).toEqual({
      hint: '核查 agent 正在跑 · Codex 不能中途插话，消息排队，结束后转交',
      placeholder: '问核查 agent，或者补充要求',
      cost: null,
    });
  });

  it('goes straight into a running Pi run', () => {
    expect(ticketChatDestination({ ticketDisplayId: '66', liveRun: run('execution'), runtimeName: 'pi' }).hint)
      .toBe('执行 agent 正在跑 · 消息会插进它当前的工作');
  });

  it('opens a conversation run when nothing runs', () => {
    expect(ticketChatDestination({ ticketDisplayId: '66', liveRun: null, runtimeName: 'codex' })).toEqual({
      hint: '发给 #66 的 agent · 开一次对话 Run，不改变工单状态',
      placeholder: '问这张工单的 agent，或者补充要求',
      cost: null,
    });
  });
});

// 工单 08（spec D13）：续接已结束的会话时，输入框写预估成本。2026-10-16 的 #77：问进展续接了 reviewer 的旧会话，
// 这一问花了 45.6 万 token。2026-10-19 起消息一律交给工单的 agent：没有「由 Lead 回答」，也没有「改问 Lead」。
describe('resuming an ended session', () => {
  const resume = { attemptId: 73, role: 'reviewer' as const, runtime: 'codex' as const, lastTokens: 456_000 };
  const base = { ticketDisplayId: '77', liveRun: null, runtimeName: 'codex', resume };

  it('says which session it resumes and what it may cost', () => {
    expect(ticketChatDestination(base)).toEqual({
      hint: '发给 #77 的核查 agent · 续接 Run #73 的会话，不改变工单状态',
      placeholder: '问核查 agent，或者补充要求',
      cost: '预估成本：约 45.6 万 token（按这个会话上次的用量）',
    });
  });

  it('says it cannot estimate the cost when the last run reported no usage', () => {
    expect(ticketChatDestination({ ...base, resume: { ...resume, lastTokens: null } }).cost).toBe('预估成本：无法估算');
  });

  it('goes to a running agent without a cost', () => {
    expect(ticketChatDestination({ ...base, liveRun: run('execution'), runtimeName: 'pi' })).toEqual({
      hint: '执行 agent 正在跑 · 消息会插进它当前的工作', placeholder: '问执行 agent，或者补充要求', cost: null,
    });
  });

  it('opens a new conversation run when there is no session to resume', () => {
    expect(ticketChatDestination({ ...base, resume: null })).toMatchObject({
      hint: '发给 #77 的 agent · 开一次对话 Run，不改变工单状态', cost: null,
    });
  });

  it('writes token estimates in 万 above ten thousand', () => {
    expect(tokenEstimateText(456_000)).toBe('约 45.6 万 token');
    expect(tokenEstimateText(5_860_000)).toBe('约 586 万 token');
    expect(tokenEstimateText(8_200)).toBe('约 8,200 token');
  });
});
