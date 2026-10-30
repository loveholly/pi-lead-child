// 逐条对照的清单（工单详情的验收标准）：每条一行，右边几列判定，最后一列勾选；不通过的那条标红，带证据。
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Checklist, type ChecklistItem } from '../src';
import { renderUI } from './render';

const items: ChecklistItem[] = [
  { id: 'c1', label: '输出详尽的 Token 膨胀排查分析与优化方案', verdicts: [{ label: '通过', tone: 'success' }], checked: true },
  {
    id: 'c2',
    label: '对相关 SKILL.md 及配置完成优化改动，形成清晰可核查的 Diff',
    verdicts: [{ label: '不通过', tone: 'danger' }],
    failed: true,
    evidence: '证据：只改了 SKILL.md 和 persona.md。',
  },
  { id: 'c3', label: '遵循 Prompt Cache 稳定性与工具调用最小化原则', verdicts: [null] },
];

describe('Checklist', () => {
  it('numbers each item and shows the column headers and every verdict', () => {
    renderUI(<Checklist testID="criteria" items={items} columns={[{ label: '核查员', emptyLabel: '核查员还没出结论' }]} checkColumn="你" />);
    expect(screen.getByText('核查员')).toBeTruthy();
    expect(screen.getByText('你')).toBeTruthy();
    expect(screen.getByTestId('criteria-item-c1').textContent).toContain('1');
    expect(screen.getByTestId('criteria-item-c3').textContent).toContain('3');
    expect(screen.getByText('通过')).toBeTruthy();
    expect(screen.getByText('不通过')).toBeTruthy();
    // 还没有结论的格子是一条短横，读屏读出原因。
    expect(screen.getByLabelText('核查员还没出结论').textContent).toBe('—');
  });

  it('marks a failed item red and puts its evidence under it', () => {
    renderUI(<Checklist testID="criteria" items={items} columns={[{ label: '核查员' }]} />);
    const failed = screen.getByTestId('criteria-item-c2');
    expect(getComputedStyle(failed).backgroundColor).toBe('var(--c-danger-surface)');
    expect(failed.textContent).toContain('证据：只改了 SKILL.md 和 persona.md。');
    expect(getComputedStyle(screen.getByTestId('criteria-item-c1')).backgroundColor).not.toBe('var(--c-danger-surface)');
  });

  it('reports a tick to the caller and shows the state the caller gives', () => {
    const onToggle = vi.fn();
    renderUI(
      <Checklist
        testID="criteria"
        items={items}
        checkColumn="你"
        onToggle={onToggle}
        checkLabel={(_item, index) => `你确认达到：验收标准 ${index + 1}`}
      />,
    );
    const first = screen.getByRole('checkbox', { name: '你确认达到：验收标准 1' });
    const second = screen.getByRole('checkbox', { name: '你确认达到：验收标准 2' });
    expect(first.getAttribute('aria-checked')).toBe('true');
    expect(second.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(second);
    fireEvent.click(first);
    expect(onToggle.mock.calls).toEqual([['c2', true], ['c1', false]]);
    // 组件不自己改状态。
    expect(second.getAttribute('aria-checked')).toBe('false');
  });

  it('shows the ticks without letting anyone change them when there is no handler', () => {
    renderUI(<Checklist items={items} checkColumn="你" />);
    const box = screen.getByRole('checkbox', { name: `确认：${items[0]!.label}` });
    expect(box.getAttribute('aria-disabled')).toBe('true');
  });

  it('is a plain numbered list before anyone has judged it', () => {
    renderUI(<Checklist testID="criteria" items={items.map(({ id, label }) => ({ id, label }))} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('核查员')).toBeNull();
    expect(screen.getByTestId('criteria').textContent).toContain('遵循 Prompt Cache 稳定性与工具调用最小化原则');
  });
});
