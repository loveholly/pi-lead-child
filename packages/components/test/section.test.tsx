// 能折叠的块（工单详情 4.0）：标题、出处、右边的摘要。折叠状态由外部传入，组件自己不存。
import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Section, Text } from '../src';
import { renderUI } from './render';

describe('Section', () => {
  it('shows its title, where it comes from, its summary and its content', () => {
    renderUI(
      <Section testID="info" title="工单信息" source="系统记录" summary="5 项">
        <Text>建单 Lead · 今天 15:02</Text>
      </Section>,
    );
    const block = screen.getByTestId('info');
    expect(block.textContent).toContain('工单信息');
    expect(block.textContent).toContain('系统记录');
    expect(block.textContent).toContain('5 项');
    expect(screen.getByText('建单 Lead · 今天 15:02')).toBeTruthy();
    // 没给 onToggle：标题行不能点，也没有折叠按钮。
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('leaves only the title row and the summary when collapsed', () => {
    renderUI(
      <Section testID="exec" title="执行" summary="Claude Code · 15 分 51 秒 · 约 598 万 token · $2.58" collapsed onToggle={() => {}}>
        <Text>执行者 Claude Code</Text>
      </Section>,
    );
    expect(screen.queryByText('执行者 Claude Code')).toBeNull();
    expect(screen.queryByTestId('exec-body')).toBeNull();
    expect(screen.getByText('Claude Code · 15 分 51 秒 · 约 598 万 token · $2.58')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: '执行，展开' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('asks the caller to change the state and does not change it by itself', () => {
    const onToggle = vi.fn();
    renderUI(
      <Section testID="plan" title="执行计划" collapsed={false} onToggle={onToggle}>
        <Text>1. 现状剖析</Text>
      </Section>,
    );
    fireEvent.click(screen.getByRole('button', { name: '执行计划，折叠' }));
    expect(onToggle).toHaveBeenCalledWith(true);
    // 调用方没有改 collapsed，内容还在。
    expect(screen.getByText('1. 现状剖析')).toBeTruthy();
    expect(screen.getByTestId('plan-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('opens and closes when the caller keeps the state', () => {
    function Controlled() {
      const [collapsed, setCollapsed] = useState(true);
      return (
        <Section title="经过与记录" collapsed={collapsed} onToggle={setCollapsed} variant="group">
          <Text>15:18 第 1 次交付，进入核查。</Text>
        </Section>
      );
    }
    renderUI(<Controlled />);
    expect(screen.queryByText('15:18 第 1 次交付，进入核查。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '经过与记录，展开' }));
    expect(screen.getByText('15:18 第 1 次交付，进入核查。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '经过与记录，折叠' }));
    expect(screen.queryByText('15:18 第 1 次交付，进入核查。')).toBeNull();
  });

  it('draws a card, a grey block, a group heading and a part of a card differently', () => {
    renderUI(
      <>
        <Section testID="card" title="任务说明" />
        <Section testID="subtle" title="验收标准" variant="subtle" />
        <Section testID="group" title="执行" variant="group" />
        <Section testID="part" title="用量" variant="part" />
      </>,
    );
    const card = getComputedStyle(screen.getByTestId('card'));
    expect(card.borderTopWidth).toBe('1px');
    expect(card.backgroundColor).toBe('var(--c-surface)');
    const subtle = getComputedStyle(screen.getByTestId('subtle'));
    expect(subtle.backgroundColor).toBe('var(--c-surface-subtle)');
    expect(subtle.borderTopWidth).not.toBe('1px');
    expect(getComputedStyle(screen.getByTestId('group')).borderTopWidth).not.toBe('1px');
    const part = getComputedStyle(screen.getByTestId('part'));
    expect(part.borderTopWidth).toBe('1px');
    expect(part.borderLeftWidth).not.toBe('1px');
  });

  it('can drop the padding around content that is edge-to-edge rows', () => {
    renderUI(
      <>
        <Section testID="padded" title="工单信息"><Text>值</Text></Section>
        <Section testID="flush" title="改动的文件" inset={false}><Text>行</Text></Section>
      </>,
    );
    // Tamagui 把 px 写成 padding-inline，jsdom 不把它换算成 padding-left，所以直接读这一项。
    const padded = getComputedStyle(screen.getByTestId('padded-body'));
    expect(padded.getPropertyValue('padding-inline')).toBe('14px');
    expect(padded.paddingBottom).toBe('12px');
    const flush = getComputedStyle(screen.getByTestId('flush-body'));
    expect(flush.getPropertyValue('padding-inline')).toBe('');
    expect(flush.paddingBottom).not.toBe('12px');
  });

  // 卡片里的第一段没有标题、上面也没有分隔线（第四轮画板：执行卡片最上面的执行者和核查员两行）。
  it('can leave out the title row and the divider of the first part in a card', () => {
    renderUI(<Section testID="profiles" variant="part" divider={false}><Text>执行者 Claude Code</Text></Section>);

    expect(screen.getByText('执行者 Claude Code')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(getComputedStyle(screen.getByTestId('profiles')).borderTopWidth).not.toBe('1px');
    expect(getComputedStyle(screen.getByTestId('profiles-body')).paddingTop).toBe('12px');
  });
});
