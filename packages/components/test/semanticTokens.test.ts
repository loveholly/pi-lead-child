import { describe, expect, it } from 'vitest';

import { densities, spacing, spacingByDensity, textLeading, textSizes, textSizesByDensity } from '../src';
import { config, tokens } from '../src/theme/config';
import { densityThemeValues } from '../src/theme/density';

// 语义 token（2026-10-21，2026-10-22 定下比例尺和密度）：会话的值由用户定下；其余名字的值只取比例尺上的数。
// 这里固定规则和用户定的值：改数值时改这里，也就是改了所有用这个名字的地方。
const value = (token: unknown) => (typeof token === 'object' && token !== null && 'val' in token ? token.val : token);

// 间距比例尺：4 的倍数，加 2 和 6 两个半步。
const onSpacingScale = (px: number) => px === 2 || px === 6 || (px > 0 && px % 4 === 0);
// 字号七档（标准）；宽松档的大标题多一档 28。最小 11 是可读性底线。
const TEXT_SIZES = [11, 12, 13, 14, 16, 20, 24, 28];

describe('semantic spacing', () => {
  it('keeps the conversation spacing the user chose', () => {
    expect(spacing['conversation-block']).toBe(14);
    expect(spacing['reply-block']).toBe(8);
    expect(spacing['list-row']).toBe(6);
  });

  it('puts every density value on the scale and orders compact ≤ standard ≤ comfortable', () => {
    for (const [name, [compact, standard, comfortable]] of Object.entries(spacingByDensity)) {
      for (const px of [compact, standard, comfortable]) expect(onSpacingScale(px), `${name}: ${px}`).toBe(true);
      expect(compact, name).toBeLessThanOrEqual(standard);
      expect(standard, name).toBeLessThanOrEqual(comfortable);
      expect(spacing[name as keyof typeof spacing], name).toBe(standard);
    }
  });

  it('registers every name as a space token', () => {
    const space = tokens.space as Record<string, unknown>;
    for (const [name, px] of Object.entries(spacing)) expect(value(space[name]), name).toBe(px);
  });

  it('puts the compact and comfortable values in the density themes', () => {
    const themes = config.themes as Record<string, Record<string, unknown>>;
    for (const density of densities) {
      if (density === 'standard') continue;
      const theme = themes[`light_${density}`];
      expect(theme, density).toBeDefined();
      for (const [key, px] of Object.entries(densityThemeValues(density))) expect(value(theme[key]), `${density} ${key}`).toBe(px);
    }
  });
});

describe('semantic text sizes', () => {
  it('keeps the message sizes and the 24px line height the user chose', () => {
    expect(textSizes['message-body']).toBe(14);
    expect(textSizes['message-lead']).toBe(16);
    expect(textLeading['message-body']).toBe(24);
    expect(textLeading['message-lead']).toBe(24);
  });

  it('uses only the seven sizes, never below 11, with an even line height above the size', () => {
    for (const [name, levels] of Object.entries(textSizesByDensity)) {
      for (const [size, leading] of levels) {
        expect(TEXT_SIZES, `${name}: ${size}`).toContain(size);
        expect(leading % 2, `${name}: ${leading}`).toBe(0);
        expect(leading, name).toBeGreaterThan(size);
      }
      expect(levels[0][0]).toBeLessThanOrEqual(levels[1][0]);
      expect(levels[1][0]).toBeLessThanOrEqual(levels[2][0]);
      expect(textSizes[name as keyof typeof textSizes]).toBe(levels[1][0]);
      expect(textLeading[name as keyof typeof textLeading]).toBe(levels[1][1]);
    }
  });

  it('registers every name as a size and line height of every font', () => {
    for (const font of Object.values(config.fonts)) {
      const sizes = font.size as Record<string, unknown>;
      const leadings = font.lineHeight as Record<string, unknown>;
      for (const [name, px] of Object.entries(textSizes)) expect(value(sizes[name]), name).toBe(px);
      for (const [name, px] of Object.entries(textLeading)) expect(value(leadings[name]), name).toBe(px);
    }
  });
});
