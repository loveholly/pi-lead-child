// 会话里的警告/失败（NoticeRow）。2026-10-16 用户要求：卡片太大。去掉「技术详情」文字按钮，整张卡是一行可以展开的
// 条目，像下面的「Lead 动态」一样有箭头；收起时一两行（图标、一句话、「共 2 次 · 最近 20:06」），展开看详情；
// 严重程度只用左边一条细色条表示，不铺大块的底色。
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NoticeRow } from '../src';
import { renderUI } from './render';

describe('NoticeRow', () => {
  it('is one row with the sentence and the count, and opens to show the details', () => {
    renderUI(
      <NoticeRow
        testID="notice"
        tone="danger"
        title="Lead 的模型服务暂时连不上，系统会自动再试。"
        meta="共 2 次 · 最近 20:06"
        details="503 upstream connect error"
      />,
    );
    const row = screen.getByRole('button', { name: 'Lead 的模型服务暂时连不上，系统会自动再试。，展开详情' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('共 2 次 · 最近 20:06')).toBeTruthy();
    expect(screen.queryByText('503 upstream connect error')).toBeNull();
    expect(screen.queryByRole('button', { name: '技术详情' })).toBeNull();

    fireEvent.click(row);
    expect(screen.getByText('503 upstream connect error')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Lead 的模型服务暂时连不上，系统会自动再试。，收起详情' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the actions on the row, and is not a toggle when there is nothing more to show', () => {
    const resend = vi.fn();
    renderUI(<NoticeRow testID="notice" tone="warning" title="没能回答这条消息。" actions={[{ label: '重发', onPress: resend }]} />);
    expect(screen.queryByRole('button', { name: /展开详情/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重发' }));
    expect(resend).toHaveBeenCalled();
  });

  it('marks the severity with a thin left accent on a white row, not a tinted block', () => {
    renderUI(<NoticeRow testID="notice" tone="danger" title="出错了" />);
    const style = getComputedStyle(screen.getByTestId('notice'));
    expect(style.borderLeftWidth).toBe('3px');
    expect(style.backgroundColor).toBe('var(--c-surface)');
  });
});
