// 2026-10-17：web 上加粗的中文不变粗。字体文件里没有汉字，汉字回退到系统中文字体，而 CSS 字重一律是 400。
// 修法：family 后面接中文字体，font-weight 用字体文件的真实字重，并关掉浏览器的合成粗体。
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Text } from '../src';
import { config, webFontFamily } from '../src/theme/config';
import { renderUI } from './render';

describe('Chinese text in a bold face on the web', () => {
  it('falls back to a Chinese system font after the loaded face', () => {
    expect(webFontFamily('bold')).toBe('JakartaBold, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC", sans-serif');
    expect(webFontFamily('mono-medium').endsWith('monospace')).toBe(true);
    expect(config.fonts.bold.family).toBe(webFontFamily('bold'));
  });

  it('asks for the real weight of each face, so the Chinese fallback gets the same weight', () => {
    expect(config.fonts.regular.weight?.['9']).toBe('400');
    expect(config.fonts.semibold.weight?.['9']).toBe('600');
    expect(config.fonts.bold.weight?.['9']).toBe('700');
    expect(config.fonts['mono-bold'].weight?.['9']).toBe('700');
  });

  it('gives bold text the bold weight, not only the bold file', () => {
    renderUI(<><Text testID="bold" weight="bold">已在原工单派发</Text><Text testID="mono" mono>5242 ms</Text><Text testID="plain">正文</Text></>);
    expect(getComputedStyle(screen.getByTestId('bold')).fontWeight).toBe('700');
    expect(getComputedStyle(screen.getByTestId('mono')).fontWeight).toBe('500');
    expect(getComputedStyle(screen.getByTestId('plain')).fontWeight).not.toBe('700');
  });

  it('turns off synthesized bold, so a bold face is not made bolder', () => {
    renderUI(<></>);
    expect(document.getElementById('ui-font-synthesis')?.textContent).toBe('html { font-synthesis: none; }');
  });
});
