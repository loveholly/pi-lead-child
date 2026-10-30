import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FairyEye } from '../src';
import {
  fairyDepth,
  fairyEase,
  fairyLayerScale,
  fairyLayers,
  fairyMotion,
  fairyNextAngle,
  fairyPalettes,
  fairyTurnSpeed,
} from '../src/display/FairyEye.shared';
import { renderUI } from './render';

// 相对亮度和对白底的对比度（WCAG）。
function contrastOnWhite(hex: string): number {
  const channel = (index: number) => {
    const value = Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return 1.05 / (luminance + 0.05);
}

// 某一层缩到最小的时刻：相位到 0.5 时。
const contractedAt = (layer: keyof typeof fairyLayers) => ((0.5 - fairyLayers[layer].lead + 1) % 1) * fairyMotion.breathMs;

describe('FairyEye motion spec', () => {
  it('eases along the breathing curve with exact ends', () => {
    expect(fairyEase(0)).toBe(0);
    expect(fairyEase(1)).toBe(1);
    expect(fairyEase(0.5)).toBeCloseTo(0.5, 3);
    // 两头慢、中间快：前 20% 的时间走得少于 20%。
    expect(fairyEase(0.2)).toBeLessThan(0.2);
    expect(fairyEase(0.8)).toBeGreaterThan(0.8);
  });

  it('does not breathe while idle', () => {
    for (const layer of Object.keys(fairyLayers) as (keyof typeof fairyLayers)[]) {
      expect(fairyLayerScale(layer, contractedAt(layer), 0, 1)).toBe(fairyLayers[layer].expanded);
    }
  });

  it('shrinks each layer to its contracted size halfway through a breath', () => {
    for (const layer of Object.keys(fairyLayers) as (keyof typeof fairyLayers)[]) {
      expect(fairyLayerScale(layer, contractedAt(layer), 1, 1)).toBeCloseTo(fairyLayers[layer].contracted, 3);
    }
  });

  it('starts with the pupil and lets the outer layers follow', () => {
    const time = 300;
    const progress = (layer: keyof typeof fairyLayers) => {
      const spec = fairyLayers[layer];
      return (spec.expanded - fairyLayerScale(layer, time, 1, 1)) / (spec.expanded - spec.contracted);
    };
    expect(progress('pupil')).toBeGreaterThan(progress('iris'));
    expect(progress('iris')).toBeGreaterThan(progress('irisOuter'));
    expect(progress('irisOuter')).toBeGreaterThan(progress('sclera'));
  });

  it('breathes deeper at small sizes', () => {
    expect(fairyDepth(18)).toBe(fairyMotion.smallDepth);
    expect(fairyDepth(32)).toBe(1);
    const time = contractedAt('pupil');
    expect(fairyLayerScale('pupil', time, 1, fairyDepth(18))).toBeLessThan(fairyLayerScale('pupil', time, 1, 1));
  });

  it('holds still at a fixed point under reduced motion', () => {
    expect(fairyLayerScale('pupil', 0, 1, 1, 0.6)).toBe(fairyLayerScale('pupil', 999, 1, 1, 0.6));
    expect(fairyLayerScale('pupil', 0, 1, 1, 0.6)).toBeLessThan(1);
  });

  it('turns slowly when idle, faster when thinking, and not at all when still', () => {
    expect(fairyTurnSpeed('idle', true)).toBeCloseTo(360 / 24_000);
    expect(fairyTurnSpeed('thinking', true)).toBeCloseTo(360 / 8_000);
    expect(fairyTurnSpeed('thinking', false)).toBe(0);
  });

  it('keeps the square angle within a quarter turn and ignores long frame gaps', () => {
    expect(fairyNextAngle(89, 1, 2)).toBeCloseTo(1);
    // 标签页切回来时一帧可能隔了几秒：最多按 64ms 走，不跳一大截。
    expect(fairyNextAngle(0, 0.01, 5_000)).toBeCloseTo(0.64);
  });

  it('keeps every disc visible on white (graphics at least 3:1)', () => {
    for (const palette of Object.values(fairyPalettes)) {
      expect(contrastOnWhite(palette.disc)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('FairyEye', () => {
  it('names itself and says when it is thinking', () => {
    renderUI(<FairyEye name="Paimon" state="thinking" testID="fairy" />);
    expect(screen.getByTestId('fairy').getAttribute('aria-label')).toBe('Paimon 在想');
    expect(screen.getByRole('img', { name: 'Paimon 在想' })).toBeTruthy();
  });

  it('never claims to think in a still tone', () => {
    renderUI(<FairyEye name="Paimon" state="thinking" tone="muted" testID="fairy" />);
    expect(screen.getByTestId('fairy').getAttribute('aria-label')).toBe('Paimon');
  });

  it('takes the size it is given', () => {
    renderUI(<FairyEye size={32} testID="fairy" />);
    const style = getComputedStyle(screen.getByTestId('fairy'));
    expect(style.width).toBe('32px');
    expect(style.height).toBe('32px');
  });
});
