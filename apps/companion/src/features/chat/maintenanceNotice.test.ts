import { describe, expect, it } from 'vitest';
import { maintenanceNoticeFor, splitMaintenanceNotice } from './maintenanceNotice';

describe('maintenanceNoticeFor', () => {
  it('turns a host model-switch status into a system notice', () => {
    expect(maintenanceNoticeFor(
      '【系统】正在把 Lead 从 vibeproxy/gemini-3.7-flash-high 切换到 vibeproxy/claude-sonnet-5。当前对话会短暂中断，起来后使用新模型。',
    )).toBe('正在把 Lead 从 vibeproxy/gemini-3.7-flash-high 切换到 vibeproxy/claude-sonnet-5。当前对话会短暂中断，起来后使用新模型。');
  });

  it('leaves ordinary Lead replies and the empty-turn error alone', () => {
    expect(maintenanceNoticeFor('好，已经切到 Sonnet 5。')).toBeNull();
    expect(maintenanceNoticeFor('Lead 未生成回复，请重试。')).toBeNull();
    expect(maintenanceNoticeFor('')).toBeNull();
  });

  it('does not expose ordinary replies as a maintenance remainder', () => {
    expect(splitMaintenanceNotice('收到，消息已顺利送达。')).toEqual({ notice: null, remainder: null });
  });

  it('keeps Lead text after the system line as ordinary remainder', () => {
    const { notice, remainder } = splitMaintenanceNotice(
      '【系统】正在把 Lead 从 A 切换到 B。当前对话会短暂中断，起来后使用新模型。\n已经安排重启。',
    );
    expect(notice).toContain('正在把 Lead 从 A 切换到 B');
    expect(remainder).toBe('已经安排重启。');
  });
});
