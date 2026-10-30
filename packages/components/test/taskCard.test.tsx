// 任务卡：一轮助手回复的工作步骤（工具调用和工具之间说的话）。仿 Slack 的 agent 任务卡。
// 收起时一行：在想、在跑哪个工具、做完了几个工具用了多久、出错了。展开是一条时间线。
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TaskCard, UIProvider, type TaskCardStep } from '../src';
import {
  formatToolDetail,
  groupTaskSteps,
  summarizeToolArgs,
  taskCardSummary,
} from '../src/display/TaskCard.shared';
import { renderUI } from './render';

const tool = (id: string, name: string, args: unknown, extra: Partial<Extract<TaskCardStep, { kind: 'tool' }>> = {}): TaskCardStep => ({
  kind: 'tool',
  id,
  name,
  state: 'done',
  args: args === null ? null : JSON.stringify(args),
  result: null,
  error: null,
  ...extra,
});

const note = (id: string, text: string): TaskCardStep => ({ kind: 'note', id, text });

describe('the collapsed line', () => {
  it('says Thinking while the model generates and no tool runs', () => {
    expect(taskCardSummary({ status: 'thinking', steps: [] })).toEqual({ tone: 'running', title: 'Thinking', detail: null });
    expect(taskCardSummary({ status: 'working', steps: [tool('a', 'list_items', {})] }))
      .toEqual({ tone: 'running', title: 'Thinking', detail: null });
  });

  // spec D9：回合还在进行时，收起的一行写这一轮已经过去的时间。
  it('adds the time since the turn started while it runs', () => {
    expect(taskCardSummary({ status: 'thinking', steps: [], durationMs: 12_000 })).toEqual({ tone: 'running', title: 'Thinking', detail: '12 秒' });
    const steps = [tool('b', 'query_tickets', { stage: 'review' }, { state: 'running' })];
    expect(taskCardSummary({ status: 'working', steps, durationMs: 65_000 }))
      .toEqual({ tone: 'running', title: 'query_tickets', detail: 'stage=review · 1 分 5 秒' });
  });

  it('names the running tool and its most meaningful argument', () => {
    const steps = [
      tool('a', 'list_items', {}),
      tool('b', 'query_tickets', { stage: 'review' }, { state: 'running' }),
    ];
    expect(taskCardSummary({ status: 'working', steps })).toEqual({ tone: 'running', title: 'query_tickets', detail: 'stage=review' });
  });

  it('counts the tools and the time when the turn finished', () => {
    const steps = Array.from({ length: 10 }, (_, index) => tool(String(index), 'query_tickets', {}));
    expect(taskCardSummary({ status: 'done', steps: [note('n', '先查一下。'), ...steps], durationMs: 12_400 }))
      .toEqual({ tone: 'done', title: '10 个工具 · 12 秒', detail: null });
    expect(taskCardSummary({ status: 'done', steps: [tool('a', 'x', {}, { state: 'failed' })], durationMs: 125_000 }))
      .toEqual({ tone: 'done', title: '1 个工具 · 1 个失败 · 2 分 5 秒', detail: null });
  });

  it('shows an error state when the turn failed', () => {
    expect(taskCardSummary({ status: 'failed', steps: [tool('a', 'x', {}), tool('b', 'y', {})], durationMs: 3_000 }))
      .toEqual({ tone: 'failed', title: '回复未完成 · 2 个工具已完成 · 3 秒', detail: null });
  });

  // 2026-10-16：建好提醒以后这一轮失败了，卡片只写「未完成 · 1个工具」，看不出提醒已经建好。
  it('says which tools finished when the turn failed', () => {
    expect(taskCardSummary({ status: 'failed', steps: [tool('a', 'create_reminder', {})], durationMs: 1_000 }))
      .toEqual({ tone: 'failed', title: '回复未完成 · 1 个工具已完成 · 1 秒', detail: null });
    expect(taskCardSummary({ status: 'failed', steps: [tool('a', 'x', {}), tool('b', 'y', {}, { state: 'stopped' })] }))
      .toEqual({ tone: 'failed', title: '回复未完成 · 2 个工具，1 个已完成', detail: null });
  });
});

describe('grouping', () => {
  it('groups consecutive calls of the same tool, and nothing else', () => {
    const items = groupTaskSteps([
      note('n1', '我先去查一下。'),
      ...['1', '2', '3', '4', '5', '6'].map((id) => tool(id, 'query_tickets', { stage: id })),
      tool('7', 'list_items', {}),
      note('n2', '再看一遍。'),
      tool('8', 'query_tickets', {}),
    ]);
    expect(items.map((item) => item.kind === 'group' ? `${item.name} ×${item.steps.length}` : item.kind === 'note' ? item.step.text : item.step.name))
      .toEqual(['我先去查一下。', 'query_tickets ×6', 'list_items', '再看一遍。', 'query_tickets']);
  });

  it('marks a group as running or failed when one of its calls is', () => {
    const [running] = groupTaskSteps([tool('1', 'q', {}), tool('2', 'q', {}, { state: 'running' })]);
    const [failed] = groupTaskSteps([tool('1', 'q', {}, { state: 'failed' }), tool('2', 'q', {})]);
    expect(running).toMatchObject({ kind: 'group', state: 'running' });
    expect(failed).toMatchObject({ kind: 'group', state: 'failed' });
  });
});

describe('argument display', () => {
  it('prefers the command, the path, the query or the ticket id', () => {
    expect(summarizeToolArgs(JSON.stringify({ command: 'npm test', description: 'run tests', timeout: 60 }))).toBe('npm test');
    expect(summarizeToolArgs(JSON.stringify({ file_path: '/repo/src/app.ts', limit: 20 }))).toBe('/repo/src/app.ts');
    expect(summarizeToolArgs(JSON.stringify({ query: 'stage:review', limit: 5 }))).toBe('stage:review');
    expect(summarizeToolArgs(JSON.stringify({ ticket_id: 66, stage: 'done' }))).toBe('#66 stage=done');
    expect(summarizeToolArgs(JSON.stringify({ stage: 'review', limit: 5 }))).toBe('stage=review limit=5');
    expect(summarizeToolArgs(JSON.stringify({}))).toBe('');
    expect(summarizeToolArgs(null)).toBe('');
  });

  it('keeps it to one line', () => {
    const summary = summarizeToolArgs(JSON.stringify({ command: `echo start\n${'x '.repeat(200)}` }));
    expect(summary).not.toContain('\n');
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(summary.endsWith('…')).toBe(true);
  });

  // 参数和结果在进卡片之前已经脱敏（protocol 的 projectToolDisplay），卡片只排版。
  it('leaves fields that were redacted upstream out of the one-line summary', () => {
    expect(summarizeToolArgs(JSON.stringify({ token: '[REDACTED]', stage: 'review' }))).toBe('stage=review');
    expect(summarizeToolArgs(JSON.stringify({ command: "curl -H 'Authorization: [REDACTED]' https://x" })))
      .toBe("curl -H 'Authorization: [REDACTED]' https://x");
  });

  it('shows the full arguments as they arrive, formatted', () => {
    const detail = formatToolDetail(JSON.stringify({ token: '[REDACTED]', stage: 'review' }));
    expect(detail).toContain('"token": "[REDACTED]"');
    expect(detail).toContain('"stage": "review"');
    expect(formatToolDetail('{"content":[{"type":"text","text":"{\\"id\\":66}"}]}')).toContain('"id": 66');
  });
});

describe('TaskCard on web', () => {
  const steps: TaskCardStep[] = [
    note('n1', '我先去查一下。'),
    tool('1', 'query_tickets', { stage: 'review' }, { result: '[]' }),
    tool('2', 'query_tickets', { stage: 'active', token: '[REDACTED]' }, { result: '[{"id":66}]' }),
    tool('3', 'list_items', {}, { state: 'failed', error: 'db locked' }),
  ];

  it('is one line with a button that expands it', () => {
    renderUI(<TaskCard status="done" steps={steps} durationMs={12_000} testID="card" />);
    const toggle = screen.getByRole('button', { name: /3 个工具 · 1 个失败 · 12 秒/ });
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // 被控制的区域还不存在时不指向它。
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    expect(screen.queryByText('我先去查一下。')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(body).not.toBeNull();
    expect(within(body!).getByText('我先去查一下。')).toBeTruthy();
    expect(within(body!).getByText('query_tickets')).toBeTruthy();
    expect(within(body!).getByText('×2')).toBeTruthy();
  });

  it('expands a group into its calls and a call into its full arguments and result', () => {
    renderUI(<TaskCard status="done" steps={steps} durationMs={12_000} expanded />);
    const group = screen.getByRole('button', { name: /query_tickets ×2/ });
    expect(group.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(group);
    expect(group.getAttribute('aria-expanded')).toBe('true');

    const second = screen.getByRole('button', { name: /query_tickets.*stage=active/ });
    fireEvent.click(second);
    expect(second.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/"stage": "active"/)).toBeTruthy();
    expect(screen.getByText(/"id": 66/)).toBeTruthy();
    expect(screen.getByText(/"token": "\[REDACTED\]"/)).toBeTruthy();
  });

  it('marks a call that never ended in a finished turn as not completed, without a spinner', () => {
    const unfinished = [tool('a', 'bash', { command: 'sleep 99' }, { state: 'stopped' })];
    expect(taskCardSummary({ status: 'done', steps: unfinished, durationMs: null }))
      .toEqual({ tone: 'done', title: '1 个工具 · 1 个未完成', detail: null });
    renderUI(<TaskCard status="done" steps={unfinished} expanded />);
    expect(screen.getByRole('button', { name: 'bash，sleep 99，未完成' })).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('shows why a call failed', () => {
    renderUI(<TaskCard status="done" steps={steps} durationMs={12_000} expanded expandedStepIds={['3']} />);
    expect(screen.getByText('db locked')).toBeTruthy();
  });

  it('lets the owner keep it expanded', () => {
    let expanded = false;
    const view = renderUI(<TaskCard status="thinking" steps={[]} expanded={expanded} onExpandedChange={(next) => { expanded = next; }} />);
    fireEvent.click(screen.getByRole('button', { name: /Thinking/ }));
    expect(expanded).toBe(true);
    view.rerender(<UIProvider><TaskCard status="thinking" steps={[]} expanded={expanded} onExpandedChange={(next) => { expanded = next; }} /></UIProvider>);
    expect(screen.getByRole('button', { name: /Thinking/ }).getAttribute('aria-expanded')).toBe('true');
  });
});

// 2026-10-15 用户决定（方案 A 画布评论）：消息正文上面的工具卡片抢了正文的重点（白底、边框、绿色勾）。
// 主会话把工具调用并进消息头，写成和时间一样的灰色小字，点开才是时间线。只有失败时才加一段琥珀色的提示。
describe('the inline variant', () => {
  const twoTools = [tool('a', 'query_tickets', {}), tool('b', 'add_comment', { id: 66 })];

  it('sits in the message header as a small toggle, without a card frame or a success marker', () => {
    renderUI(
      <TaskCard variant="inline" leading="Lead · 17:57" status="done" steps={twoTools} durationMs={21_000} testID="turn" />,
    );
    expect(screen.getByText('Lead · 17:57')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: /2 个工具 · 21 秒/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('turn-marker')).toBeNull();
    expect(screen.queryByTestId('turn')).toBeNull();
    expect(screen.getByTestId('turn-inline')).toBeTruthy();
  });

  // 2026-10-28 方案 C（主题 F-5）：消息头前面是 Fairy。在跑时 Fairy 的呼吸表示还在跑，摘要前面不再多一个小转圈。
  it('puts a leading mark before the header and drops its own spinner for it', () => {
    const running = [tool('a', 'query_tickets', {}, { state: 'running' })];
    const view = renderUI(<TaskCard variant="inline" leading="Lead · 17:57" status="working" steps={running} />);
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
    view.unmount();
    renderUI(
      <TaskCard variant="inline" leading="Lead · 17:57" status="working" steps={running}
        leadingMark={<span data-testid="mark">F</span>} />,
    );
    expect(screen.getByTestId('mark')).toBeTruthy();
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
  });

  it('opens the same timeline under the header', () => {
    renderUI(<TaskCard variant="inline" leading="Lead · 17:57" status="done" steps={twoTools} durationMs={21_000} />);
    const toggle = screen.getByRole('button', { name: /2 个工具/ });
    fireEvent.click(toggle);
    const body = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(within(body!).getByText('add_comment')).toBeTruthy();
  });

  it('calls out failed tools separately, and stays quiet when everything worked', () => {
    const view = renderUI(<TaskCard variant="inline" leading="Lead" status="done" steps={twoTools} durationMs={1_000} testID="turn" />);
    expect(screen.queryByTestId('turn-failures')).toBeNull();
    view.unmount();
    renderUI(
      <TaskCard variant="inline" leading="Lead" status="done" durationMs={1_000} testID="turn"
        steps={[tool('a', 'query_tickets', {}), tool('b', 'add_comment', {}, { state: 'failed', error: 'db locked' })]} />,
    );
    expect(screen.getByTestId('turn-failures').textContent).toBe('1 个失败');
  });

  it('keeps the card variant as before for other surfaces', () => {
    renderUI(<TaskCard status="done" steps={twoTools} durationMs={21_000} testID="turn" />);
    expect(screen.getByTestId('turn')).toBeTruthy();
    expect(screen.getByTestId('turn-marker')).toBeTruthy();
  });
});
