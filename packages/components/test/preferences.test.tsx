import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Card, Column, Density, DesignPreferencesProvider, Row, Text, designColorOverrides } from '../src';
import { contrastRatio } from '../src/theme/preferences';
import { renderUI } from './render';

// 外观偏好（2026-10-22）：密度按区域取、字号和行高按档位调、圆角按档位乘系数、颜色按同色系推导。
describe('design preferences', () => {
  it('picks each zone density from the preferences', () => {
    renderUI(
      <DesignPreferencesProvider value={{ density: { workspace: 'comfortable', ticket: 'standard', conversation: 'standard', settings: 'compact' } }}>
        <Density zone="workspace"><Row testID="workspace" gap="card-row" /></Density>
        <Density zone="ticket"><Row testID="ticket" gap="card-row" /></Density>
        <Density zone="settings"><Row testID="settings" gap="card-row" /></Density>
      </DesignPreferencesProvider>,
    );
    expect(getComputedStyle(screen.getByTestId('workspace')).gap).toBe('12px');
    expect(getComputedStyle(screen.getByTestId('ticket')).gap).toBe('var(--t-space-card-row)');
    expect(getComputedStyle(screen.getByTestId('settings')).gap).toBe('6px');
  });

  it('scales text and line height together, never below 11', () => {
    renderUI(
      <DesignPreferencesProvider value={{ textScale: 'small', lineHeight: 'loose' }}>
        <Column>
          <Text testID="title" size="card-title">标题</Text>
          <Text testID="meta" size="meta">11:02</Text>
          <Text testID="fixed" size="message-body">正文</Text>
        </Column>
      </DesignPreferencesProvider>,
    );
    // card-title 标准 14/20：小一号 13，行高 20 − 2（跟字号）+ 2（松）= 20。
    const title = getComputedStyle(screen.getByTestId('title'));
    expect(title.fontSize).toBe('13px');
    expect(title.lineHeight).toBe('20px');
    // meta 标准 11/16：小一号还是 11（底线），行高 16 + 2 = 18。
    const meta = getComputedStyle(screen.getByTestId('meta'));
    expect(meta.fontSize).toBe('11px');
    expect(meta.lineHeight).toBe('18px');
    // 会话正文不跟档位走。
    expect(getComputedStyle(screen.getByTestId('fixed')).fontSize).toBe('var(--f-size-message-body)');
  });

  it('multiplies radius tokens by the radius level', () => {
    renderUI(
      <DesignPreferencesProvider value={{ radius: 'round' }}>
        <Card testID="card" rounded="xl" />
        <Card testID="pill" rounded="full" />
      </DesignPreferencesProvider>,
    );
    // xl 是 12：大圆角 ×1.5 = 18。full 不变。
    expect(getComputedStyle(screen.getByTestId('card')).borderRadius).toBe('18px');
    expect(getComputedStyle(screen.getByTestId('pill')).borderRadius).toBe('var(--t-radius-full)');
  });

  it('derives the family of a changed color and keeps text variants readable', () => {
    const overrides = designColorOverrides({ accent: '#7A5AF8', success: '#12B76A', warning: '#F79009', danger: '#F04438', info: '#06AED4' });
    expect(Object.keys(overrides)).toContain('accent-soft');
    expect(Object.keys(overrides)).not.toContain('success-soft');
    expect(contrastRatio(overrides['accent-soft']!, '#FFFFFF')).toBeLessThan(1.4);
    expect(contrastRatio(overrides['accent-strong']!, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(designColorOverrides({ accent: '#2F6AFF', success: '#12B76A', warning: '#F79009', danger: '#F04438', info: '#06AED4' })).toEqual({});
  });

  it('writes the color overrides as CSS variables on the web', () => {
    renderUI(
      <DesignPreferencesProvider value={{ colors: { accent: '#7A5AF8', success: '#12B76A', warning: '#F79009', danger: '#F04438', info: '#06AED4' } }}>
        <Row />
      </DesignPreferencesProvider>,
    );
    const style = document.getElementById('ui-design-colors');
    expect(style?.textContent).toContain('--c-accent:#7A5AF8');
    expect(style?.textContent).toContain('--c-accent-soft:');
  });
});
