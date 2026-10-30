// 详情页的头部（工单详情 4.1，第四轮画板）：编号、完整标题、状态和项目；往下滚动以后收成一行。
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Badge, DetailHeader } from '../src';
import { renderUI } from './render';

const TITLE = '优化 aish code review skill：降低 Token 消耗、收敛 Bash 调用与优化 Cache';

describe('DetailHeader', () => {
  it('shows the number, the full title, the badges and the project, and closes', () => {
    const onClose = vi.fn();
    renderUI(<DetailHeader testID="head" id="#102" title={TITLE} badges={<Badge label="执行中" />} project="agent-app" onClose={onClose} closeLabel="关闭工单详情" />);

    expect(screen.getByTestId('head').textContent).toContain('#102');
    // 完整标题可以换行，不截断。
    expect(screen.getByTestId('head-title').textContent).toBe(TITLE);
    expect(screen.getByTestId('head-meta').textContent).toContain('执行中');
    expect(screen.getByTestId('head-meta').textContent).toContain('agent-app');
    fireEvent.click(screen.getByRole('button', { name: '关闭工单详情' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('folds into one row: number and title only', () => {
    renderUI(<DetailHeader testID="head" id="#102" title={TITLE} badges={<Badge label="执行中" />} project="agent-app" compact />);

    expect(screen.getByTestId('head-title').textContent).toBe(TITLE);
    expect(screen.queryByTestId('head-meta')).toBeNull();
  });

  it('puts a back button on the left on a phone, with the same test id as close', () => {
    const onBack = vi.fn();
    renderUI(<DetailHeader testID="head" id="#102" title={TITLE} onBack={onBack} onClose={() => {}} dense />);

    fireEvent.click(screen.getByTestId('head-close'));
    expect(onBack).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
  });
});
