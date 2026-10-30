// 从 genui 移进组件库的展示组件（2026-10-21）：聊天卡片和工单详情共用。只收普通的 props。
// 聊天卡片里的样子由 apps/companion 的 surface.test.tsx 覆盖；这里测组件本身和工单详情用的 compact 外观。
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  Badge, BarChart, FactList, Progress, Stats, Steps, Timeline, estimatedTextWidth, formatNumber, isNumericColumn, tableColumnWidth,
} from '../src';
import { renderUI } from './render';

describe('Steps', () => {
  const items = [
    { label: '1. 现状剖析与问题定位', state: 'done' as const },
    { label: '2. 工具使用与上下文精简指引重构', state: 'current' as const, detail: '在第 1 步' },
    { label: '3. 等 CI 机器', state: 'blocked' as const, detail: '受阻：CI 排队超过 30 分钟' },
    { label: '4. Prompt Cache 友好性重构', state: 'skipped' as const, detail: '跳过：宿主架构层已经分好层。' },
    { label: '5. 产出改进方案', state: 'pending' as const },
    { label: '6. 回归', state: 'failed' as const },
  ];

  it('names every state, including skipped and blocked', () => {
    renderUI(<Steps testID="plan" items={items} />);
    for (const name of ['已完成', '进行中', '受阻', '已跳过', '未开始', '失败']) expect(screen.getByLabelText(name)).toBeTruthy();
    expect(screen.getByText('受阻：CI 排队超过 30 分钟')).toBeTruthy();
  });

  it('colours a blocked step amber, apart from a failed one', () => {
    renderUI(<Steps items={items} />);
    expect(getComputedStyle(screen.getByLabelText('受阻')).backgroundColor).toBe('var(--c-warning)');
    expect(getComputedStyle(screen.getByLabelText('失败')).backgroundColor).toBe('var(--c-danger)');
  });

  it('draws the plan in the ticket detail with small light marks and no connecting line', () => {
    renderUI(
      <>
        <Steps testID="regular" items={items.slice(0, 2)} />
        <Steps testID="compact" variant="compact" items={items} />
      </>,
    );
    const compact = screen.getByTestId('compact');
    const done = compact.querySelector('[aria-label="已完成"]')!;
    expect(getComputedStyle(done).width).toBe('18px');
    expect(getComputedStyle(done).backgroundColor).toBe('var(--c-success-soft)');
    expect(getComputedStyle(compact.querySelector('[aria-label="受阻"]')!).backgroundColor).toBe('var(--c-warning-soft)');
    expect(compact.textContent).toContain('跳过：宿主架构层已经分好层。');
    // 聊天卡片的步骤之间有一条连线，执行计划没有。
    const line = (root: HTMLElement) => [...root.querySelectorAll('div')].filter((node) => getComputedStyle(node).width === '2px').length;
    expect(line(screen.getByTestId('regular'))).toBe(1);
    expect(line(compact)).toBe(0);
  });
});

describe('Stats', () => {
  it('formats numbers and shows the unit and the change', () => {
    renderUI(<Stats testID="stats" items={[{ label: 'Token', value: 5981433, unit: 'token', change: '缓存读取 94%', tone: 'info' }, { label: '成本', value: '$2.58' }]} />);
    const stats = screen.getByTestId('stats');
    expect(stats.textContent).toContain('5,981,433');
    expect(stats.textContent).toContain('token');
    expect(stats.textContent).toContain('$2.58');
    expect(getComputedStyle(screen.getByText('缓存读取 94%')).color).toBe('var(--c-accent)');
  });

  it('shares one row between the tiles in the compact usage view', () => {
    renderUI(<Stats testID="usage" variant="compact" items={[{ label: '耗时', value: '23 分 25 秒' }, { label: 'Token', value: '约 639 万' }, { label: '成本', value: '$2.77' }]} />);
    const usage = screen.getByTestId('usage');
    expect(getComputedStyle(usage).flexWrap).not.toBe('wrap');
    const tile = usage.firstElementChild!;
    expect(getComputedStyle(tile).minWidth).toBe('0px');
    expect(usage.textContent).toBe('耗时23 分 25 秒Token约 639 万成本$2.77');
  });
});

describe('Timeline', () => {
  const items = [{ at: '15:18', text: '第 1 次交付，进入核查。' }, { at: '15:19', text: '核查员从 Codex 自动换成 Pi。', tone: 'warning' as const }];

  it('keeps the given order in both looks', () => {
    renderUI(
      <>
        <Timeline testID="regular" items={items} />
        <Timeline testID="compact" variant="compact" items={items} />
      </>,
    );
    for (const id of ['regular', 'compact']) {
      const text = screen.getByTestId(id).textContent ?? '';
      expect(text.indexOf('第 1 次交付')).toBeLessThan(text.indexOf('自动换成 Pi'));
    }
  });

  it('puts the time and the event on one line in the compact look', () => {
    renderUI(<Timeline testID="history" variant="compact" items={items} />);
    const row = screen.getByText('15:18').parentElement!;
    expect(getComputedStyle(row).flexDirection).toBe('row');
    expect(row.textContent).toBe('15:18第 1 次交付，进入核查。');
    expect(getComputedStyle(screen.getByText('核查员从 Codex 自动换成 Pi。')).color).toBe('var(--c-warning-dark)');
  });
});

describe('Progress and BarChart', () => {
  it('says the progress is unknown when there is no value', () => {
    renderUI(<><Progress label="迁移文件" value={0.4} /><Progress label="等待 CI" /></>);
    expect(screen.getByText('40%')).toBeTruthy();
    expect(screen.getByText('进度未知')).toBeTruthy();
  });

  it('names each bar with its value and unit', () => {
    renderUI(<BarChart bars={[{ label: 'codex', value: 31 }, { label: 'claude', value: 1200 }]} unit="次" />);
    expect(screen.getByLabelText('codex：31 次')).toBeTruthy();
    expect(screen.getByLabelText('claude：1,200 次')).toBeTruthy();
  });
});

describe('FactList', () => {
  it('shows tagged facts with a status badge', () => {
    renderUI(<FactList testID="facts" items={[{ label: 'F1', value: '撤回的完成声明仍被登记成 complete', badge: { label: '已复现' } }]} />);
    expect(screen.getByTestId('facts').textContent).toBe('F1撤回的完成声明仍被登记成 complete已复现');
  });

  it('lines names and values up in two columns, with a link that does something', () => {
    const onSet = vi.fn();
    renderUI(
      <FactList
        testID="info"
        variant="labeled"
        items={[
          { label: '建单', value: 'Lead · 今天 15:02' },
          { label: '截止和提醒', value: '没有', action: { label: '设置', onPress: onSet } },
          { label: '核查员', value: 'Pi · gpt-5.5 · 完成', detail: '15:19 自动换人：Codex 账号已停用。' },
        ]}
      />,
    );
    const name = screen.getByText('截止和提醒');
    expect(getComputedStyle(name).width).toBe('72px');
    expect(screen.getByText('15:19 自动换人：Codex 账号已停用。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(onSet).toHaveBeenCalledTimes(1);
  });
});

describe('Badge', () => {
  it('has a 20-high size for verdicts in rows and tables', () => {
    renderUI(<Badge testID="verdict" label="通过" tone="success" size="xs" />);
    const style = getComputedStyle(screen.getByTestId('verdict'));
    expect(style.height).toBe('20px');
    expect(style.backgroundColor).toBe('var(--c-success-soft)');
  });
});

describe('table layout', () => {
  it('treats a column of numbers with units and placeholders as numeric', () => {
    expect(isNumericColumn(['1,234', '12.5%', '—', '', '3 万'])).toBe(true);
    expect(isNumericColumn(['1,234', '失败'])).toBe(false);
    expect(isNumericColumn(['—', 'n/a'])).toBe(false);
  });

  it('estimates column widths from the widest text, within bounds', () => {
    expect(estimatedTextWidth('工单')).toBe(26);
    expect(estimatedTextWidth('ab')).toBe(15);
    expect(tableColumnWidth(10)).toBe(64);
    expect(tableColumnWidth(100)).toBe(130);
    expect(tableColumnWidth(1000)).toBe(360);
  });

  it('writes numbers with thousands separators and at most two decimals', () => {
    expect(formatNumber(5981433)).toBe('5,981,433');
    expect(formatNumber(2.5833)).toBe('2.58');
  });
});
