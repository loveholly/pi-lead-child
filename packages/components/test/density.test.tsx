import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Column, Density, Row, Text } from '../src';
import { renderUI } from './render';

// 密度区域（2026-10-22）：同一个语义名在 <Density name="compact"> 之内取紧凑值，之外取标准值。
// 组件只写名字，不知道自己在哪个区域。
describe('density zones', () => {
  it('keeps the standard value outside a zone and swaps it inside', () => {
    renderUI(
      <Column>
        <Row testID="standard" gap="card-row" pt="card" />
        <Density name="compact">
          <Row testID="compact" gap="card-row" pt="card" />
          <Column testID="compact-column" gap="page-section" />
        </Density>
        <Density name="comfortable">
          <Row testID="comfortable" gap="card-row" />
        </Density>
      </Column>,
    );
    // jsdom 不解析 CSS 变量：标准值是 token，保持 var(--t-space-…) 的形式；换过值的是具体像素。
    expect(getComputedStyle(screen.getByTestId('standard')).gap).toBe('var(--t-space-card-row)');
    expect(getComputedStyle(screen.getByTestId('standard')).paddingTop).toBe('var(--t-space-card)');
    expect(getComputedStyle(screen.getByTestId('compact')).gap).toBe('6px');
    expect(getComputedStyle(screen.getByTestId('compact')).paddingTop).toBe('8px');
    expect(getComputedStyle(screen.getByTestId('compact-column')).gap).toBe('16px');
    expect(getComputedStyle(screen.getByTestId('comfortable')).gap).toBe('12px');
  });

  it('swaps the text size and its line height together', () => {
    renderUI(
      <Column>
        <Text testID="standard" size="card-title">标题</Text>
        <Text testID="fixed" size="message-body">正文</Text>
        <Density name="compact">
          <Text testID="compact" size="card-title">标题</Text>
          <Text testID="compact-fixed" size="message-body">正文</Text>
        </Density>
      </Column>,
    );
    const standard = getComputedStyle(screen.getByTestId('standard'));
    expect(standard.fontSize).toBe('var(--f-size-card-title)');
    expect(standard.lineHeight).toBe('var(--f-lineHeight-card-title)');
    const compact = getComputedStyle(screen.getByTestId('compact'));
    expect(compact.fontSize).toBe('13px');
    expect(compact.lineHeight).toBe('18px');
    // 会话正文不随密度变，行高固定 24。
    expect(getComputedStyle(screen.getByTestId('fixed')).fontSize).toBe('var(--f-size-message-body)');
    expect(getComputedStyle(screen.getByTestId('compact-fixed')).fontSize).toBe('var(--f-size-message-body)');
    expect(getComputedStyle(screen.getByTestId('compact-fixed')).lineHeight).toBe('var(--f-lineHeight-message-body)');
  });

  it('lets a standard island sit inside a compact zone', () => {
    renderUI(
      <Density name="compact">
        <Row testID="outer" gap="card-row" />
        <Density name="standard">
          <Row testID="inner" gap="card-row" />
        </Density>
      </Density>,
    );
    expect(getComputedStyle(screen.getByTestId('outer')).gap).toBe('6px');
    expect(getComputedStyle(screen.getByTestId('inner')).gap).toBe('var(--t-space-card-row)');
  });

  it('leaves pixel values and non-density names alone', () => {
    renderUI(
      <Density name="compact">
        <Row testID="px" gap={8} />
        <Row testID="fixed" gap="conversation-block" />
      </Density>,
    );
    expect(getComputedStyle(screen.getByTestId('px')).gap).toBe('8px');
    expect(getComputedStyle(screen.getByTestId('fixed')).gap).toBe('var(--t-space-conversation-block)');
  });
});
