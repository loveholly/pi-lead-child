import { describe, expect, it } from 'vitest';

import type { AgentLogEntry, ToolDisplayProjection } from '@/state/types';

import { buildTicketLogPresentation } from './ticketLogs';

function projection(preview: string): ToolDisplayProjection {
  return { preview, truncated: false, redacted: false, artifactRefs: [] };
}

function entry(overrides: Partial<AgentLogEntry> & Pick<AgentLogEntry, 'seq'>): AgentLogEntry {
  return {
    attemptId: 17,
    occurredAt: `2026-08-11T02:00:${String(overrides.seq).padStart(2, '0')}.000Z`,
    kind: 'message.completed',
    text: 'ok',
    ...overrides,
  };
}

describe('ticket log presentation', () => {
  it('merges command started and completed events around the stable call id', () => {
    const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
    const logs = buildTicketLogPresentation([
      entry({
        seq: 1,
        kind: 'tool.started',
        text: 'technical started payload',
        tool: {
          callId: 'command-1',
          name: 'command_execution',
          phase: 'started',
          args: projection('{"command":"/bin/zsh -lc \\"sed -n \'1,240p\' /Users/alice/.codex/skills/example/SKILL.md\\""}'),
          result: null,
          error: null,
          command: '/bin/zsh -lc "sed -n \'1,240p\' /Users/alice/.codex/skills/example/SKILL.md"',
          cwd: '/Users/alice/Workspace/AI/pi-lead-child',
          exitCode: null,
          output: null,
        },
      }),
      entry({
        seq: 2,
        occurredAt: '2026-08-11T02:00:03.000Z',
        kind: 'tool.completed',
        text: 'technical completed payload',
        tool: {
          callId: 'command-1',
          name: 'command_execution',
          phase: 'completed',
          args: null,
          result: projection('{"status":"completed","exitCode":0}'),
          error: null,
          command: null,
          cwd: null,
          exitCode: 0,
          output: projection(output),
        },
      }),
    ]);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      kind: 'tool',
      status: 'success',
      statusLabel: '成功',
      title: "sed -n '1,240p' ~/.codex/skills/example/SKILL.md",
      expandLabel: '完整输出',
    });
    expect(logs[0]?.meta).toContain('exit 0');
    expect(logs[0]?.meta).toContain('2.0s');
    expect(logs[0]?.meta).toContain('输出 20 行');
    expect(logs[0]?.detail).toContain('line 20');
  });

  it('formats known non-command tools around their primary argument', () => {
    const [log] = buildTicketLogPresentation([entry({
      seq: 3,
      kind: 'tool.started',
      text: 'get_ticket_tree',
      tool: {
        callId: 'tree-1',
        name: 'plc.get_ticket_tree',
        phase: 'started',
        args: projection('{"ticket_id":18}'),
        result: null,
        error: null,
        command: null,
        cwd: null,
        exitCode: null,
        output: null,
      },
    })]);

    expect(log).toMatchObject({ title: '获取任务树 · #18', status: 'running' });
  });

  it('folds ordinary agent output after 120 characters', () => {
    const text = 'a'.repeat(121);
    const [log] = buildTicketLogPresentation([entry({ seq: 4, text })]);

    expect(log?.title).toBe('Agent 输出');
    expect(log?.preview?.length).toBe(120);
    expect(log?.detail).toBe(text);
  });

  it('keeps long command titles within 120 characters', () => {
    const command = `npm test -- --run ${Array.from({ length: 12 }, (_, index) => `test/feature-${index}.test.ts`).join(' ')}`;
    const [log] = buildTicketLogPresentation([entry({
      seq: 5,
      kind: 'tool.started',
      text: command,
      tool: {
        callId: 'long-command',
        name: 'command_execution',
        phase: 'started',
        args: projection(JSON.stringify({ command })),
        result: null,
        error: null,
        command,
        cwd: null,
        exitCode: null,
        output: null,
      },
    })]);

    expect(log?.title.length).toBeLessThanOrEqual(120);
    expect(log?.title).toContain('…');
    expect(log?.detail).toContain(command);
  });
});
