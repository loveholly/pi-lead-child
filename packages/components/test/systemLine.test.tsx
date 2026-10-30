// 系统信息行（patterns P9.9）：2026-10-28 用户截图里，长的说明换成两行、居中，时间挤到第二行中间。
// 改成左对齐、永远一行：说明截断，时间单独放、不截断；全文在点开的浮层里。
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SystemLine } from '../src';
import { renderUI } from './render';

const long = '你刚刚把 GitHub 的权限设置从「Lead、执行工单的 agent、评审 agent可以用；写入先问我」改成「Lead、执行工单的 agent、评审 agent可以用；写入直接执行」';

describe('SystemLine', () => {
  it('keeps the text on one line and the time outside the truncated text', () => {
    renderUI(<SystemLine testID="line" icon="device" text={long} time="10:46" />);
    const text = screen.getByTestId('line-text');
    expect(text.textContent).toBe(long);
    expect(text.textContent).not.toContain('10:46');
    expect(screen.getByTestId('line-time').textContent).toBe('· 10:46');
    // 一行：RN-web 把 numberOfLines={1} 画成单行截断。
    expect(getComputedStyle(text).whiteSpace === 'nowrap' || text.style.webkitLineClamp === '1' || getComputedStyle(text).textOverflow === 'ellipsis').toBe(true);
    expect(getComputedStyle(screen.getByTestId('line')).justifyContent).not.toBe('center');
  });

  it('opens the full text in an anchored panel', async () => {
    renderUI(<SystemLine testID="line" icon="device" text={long} time="10:46" details={long} />);
    fireEvent.click(screen.getByTestId('line-expand'));
    expect((await screen.findByTestId('line-details')).textContent).toBe(long);
  });
});
