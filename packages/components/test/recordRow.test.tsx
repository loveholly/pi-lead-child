// 一条记录（子工单、运行记录、改动的文件）：主行、副行、右侧标签、行尾动作。
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RecordRow, Text } from '../src';
import { renderUI } from './render';

describe('RecordRow', () => {
  it('shows the id, the title, the meta, the detail and the status of a run', () => {
    renderUI(
      <RecordRow
        testID="run-118"
        id="#118"
        title="执行"
        meta="· Claude Code · sonnet · high"
        detail="15:03:04–15:18:55 · 15 分 51 秒 · 5,981,433 token · $2.58"
        detailMono
        badge={{ label: '已交付', tone: 'success' }}
      />,
    );
    const row = screen.getByTestId('run-118');
    expect(row.textContent).toBe('#118执行· Claude Code · sonnet · high已交付15:03:04–15:18:55 · 15 分 51 秒 · 5,981,433 token · $2.58');
    // 不能点的行不是按钮。
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens from the whole row, under the name the caller gives it', () => {
    const onPress = vi.fn();
    renderUI(<RecordRow id="#118" title="执行" onPress={onPress} accessibilityLabel="在中间栏看 #118 的记录" />);
    fireEvent.click(screen.getByRole('button', { name: '在中间栏看 #118 的记录' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('keeps an end action apart from pressing the row', () => {
    const onPress = vi.fn();
    const onOpen = vi.fn();
    renderUI(
      <RecordRow
        testID="file"
        title="SKILL.md"
        meta="skills/company/security-code-review/"
        metaMono
        detail="Diff mode 新增 Tool budget 和 Incremental re-review 两节"
        trailing={<Text>+15</Text>}
        onPress={onPress}
        action={{ icon: 'arrow-up-right', label: '用默认程序打开 SKILL.md', onPress: onOpen }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '用默认程序打开 SKILL.md' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'SKILL.md' }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('file').textContent).toContain('+15');
  });

  it('lines the detail up under the title when the id has a fixed width', () => {
    renderUI(
      <RecordRow
        testID="child"
        id="#19"
        idWidth={24}
        title="Phase -1：复核审计计划与当前 HEAD 的执行就绪状态"
        detail="Lead 拆的 · Claude Code · sonnet · 18 分"
        badge={{ label: '已完成', tone: 'success' }}
      />,
    );
    const detail = screen.getByText('Lead 拆的 · Claude Code · sonnet · 18 分');
    // 编号 24 宽，加上和标题之间的 8。
    expect(getComputedStyle(detail).paddingLeft).toBe('32px');
    expect(getComputedStyle(screen.getByText('#19')).width).toBe('24px');
  });

  it('draws a line above every row but the first', () => {
    renderUI(
      <>
        <RecordRow testID="first" title="a.ts" />
        <RecordRow testID="second" title="b.ts" divider />
      </>,
    );
    expect(getComputedStyle(screen.getByTestId('first')).borderTopWidth).toBe('0px');
    const second = getComputedStyle(screen.getByTestId('second'));
    expect(second.borderTopWidth).toBe('1px');
    expect(second.borderTopColor).toBe('var(--c-border-soft)');
  });
});
