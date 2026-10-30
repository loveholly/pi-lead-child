// 记录块的摘要里，数字加粗（主题 11.8）；编号和时刻不加粗。
import { describe, expect, it } from 'vitest';

import { emphasizeNumbers } from '../src';

const bold = (text: string) => emphasizeNumbers(text).filter((part) => part.number).map((part) => part.text);

describe('emphasizeNumbers', () => {
  it('bolds counts and amounts', () => {
    expect(bold('李雷催填漏洞排查表：还剩 11 条未确认')).toEqual(['11']);
    expect(bold('#118 的 CI 重跑后通过：4 项检查全绿')).toEqual(['4']);
    expect(bold('注入上下文 74,182 字节，命中率 92.5%')).toEqual(['74,182', '92.5%']);
  });

  it('leaves ticket numbers and clock times alone', () => {
    expect(bold('#104 为工单 #102 创建 PR，今晚 18:00 汇总')).toEqual([]);
  });

  it('keeps the whole text when put back together', () => {
    const text = '#118 的 CI 重跑后通过：4 项检查全绿';
    expect(emphasizeNumbers(text).map((part) => part.text).join('')).toBe(text);
  });
});
