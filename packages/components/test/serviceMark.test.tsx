import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ServiceMark, type ServiceMarkService } from '../src';
import { monogram } from '../src/display/ServiceMark';
import { renderUI } from './render';

// 设置里「连接」的服务标志。品牌色只在组件里，应用只传服务名。
describe('ServiceMark', () => {
  const cases: [ServiceMarkService, string, string][] = [
    ['atlassian', 'J', 'rgb(24, 104, 219)'],
    ['github', 'GH', 'rgb(31, 35, 40)'],
    ['notion', 'N', 'rgb(255, 255, 255)'],
    ['slack', 'S', 'rgb(74, 21, 75)'],
    ['google', 'G', 'rgb(255, 255, 255)'],
  ];

  for (const [service, letter, background] of cases) {
    it(`draws ${service} as ${letter} on its brand color`, () => {
      renderUI(<ServiceMark service={service} testID="mark" />);
      const mark = screen.getByTestId('mark');
      expect(mark.textContent).toBe(letter);
      expect(getComputedStyle(mark).backgroundColor).toBe(background);
    });
  }

  it('gives notion and google a border, and custom a dashed one', () => {
    renderUI(<><ServiceMark service="notion" testID="notion" /><ServiceMark service="custom" label="linear" testID="custom" /></>);
    expect(getComputedStyle(screen.getByTestId('notion')).borderStyle).toBe('solid');
    expect(getComputedStyle(screen.getByTestId('notion')).borderWidth).toBe('1.5px');
    expect(getComputedStyle(screen.getByTestId('custom')).borderStyle).toBe('dashed');
  });

  it('uses the first letter of the label for a custom server', () => {
    renderUI(<ServiceMark service="custom" label="linear.app" testID="mark" />);
    expect(screen.getByTestId('mark').textContent).toBe('L');
    expect(monogram('  内部 MCP')).toBe('内');
    expect(monogram('')).toBe('+');
    expect(monogram(undefined)).toBe('+');
  });

  it('comes in three sizes', () => {
    for (const size of [24, 32, 40] as const) {
      renderUI(<ServiceMark service="slack" size={size} testID={`mark-${size}`} />);
      const style = getComputedStyle(screen.getByTestId(`mark-${size}`));
      expect(style.width).toBe(`${size}px`);
      expect(style.height).toBe(`${size}px`);
    }
  });
});
