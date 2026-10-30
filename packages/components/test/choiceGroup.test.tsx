// 一组互斥的选项：聊天卡片里点了就提交的选项卡，工单详情里的单选卡（代码怎么处理、换模型）。
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChoiceGroup } from '../src';
import { renderUI } from './render';

const options = [
  { id: 'merge', label: '合并到原分支', description: '在本机合并到 aishx/task-model-routing，工单完成。' },
  { id: 'pr', label: '开草稿 PR', description: '推到 GitHub，先不合并。' },
  { id: 'keep', label: '先留在分支上' },
];

describe('ChoiceGroup as cards', () => {
  it('highlights the recommended choice and reports the one pressed', () => {
    const onSelect = vi.fn();
    renderUI(<ChoiceGroup options={options} recommended="merge" onSelect={onSelect} optionTestID={(id) => `choice-${id}`} />);
    expect(screen.getByRole('button', { name: '合并到原分支' }).textContent).toContain('推荐');
    expect(screen.getByRole('button', { name: '开草稿 PR' }).textContent).not.toContain('推荐');
    expect(screen.getByText('推到 GitHub，先不合并。')).toBeTruthy();
    fireEvent.click(screen.getByTestId('choice-pr'));
    expect(onSelect).toHaveBeenCalledWith('pr');
  });

  it('takes no choice while disabled', () => {
    const onSelect = vi.fn();
    renderUI(<ChoiceGroup options={options} onSelect={onSelect} disabled optionTestID={(id) => `choice-${id}`} />);
    expect(screen.getByTestId('choice-merge').getAttribute('aria-disabled')).toBe('true');
  });
});

describe('ChoiceGroup as radio cards', () => {
  it('is a radio group whose checked option comes from the caller', () => {
    const onSelect = vi.fn();
    renderUI(
      <ChoiceGroup
        variant="radio"
        accessibilityLabel="验收以后代码怎么处理"
        options={options}
        value="merge"
        onSelect={onSelect}
        optionTestID={(id) => `code-${id}`}
      />,
    );
    expect(screen.getByRole('radiogroup', { name: '验收以后代码怎么处理' })).toBeTruthy();
    const merge = screen.getByRole('radio', { name: '合并到原分支' });
    const pr = screen.getByRole('radio', { name: '开草稿 PR' });
    expect(merge.getAttribute('aria-checked')).toBe('true');
    expect(pr.getAttribute('aria-checked')).toBe('false');
    expect(getComputedStyle(merge).backgroundColor).toBe('var(--c-accent-wash)');
    expect(getComputedStyle(pr).backgroundColor).toBe('var(--c-surface)');
    fireEvent.click(pr);
    expect(onSelect).toHaveBeenCalledWith('pr');
    // 调用方没换 value，选中的还是原来那项。
    expect(merge.getAttribute('aria-checked')).toBe('true');
  });

  it('puts a short note at the right of an option', () => {
    renderUI(
      <ChoiceGroup
        variant="radio"
        options={[{ id: 'opus', label: 'opus', aside: '更强，更慢，成本更高' }, { id: 'sonnet', label: 'sonnet', aside: '现在用的' }]}
        value="sonnet"
      />,
    );
    expect(screen.getByRole('radio', { name: 'sonnet' }).textContent).toContain('现在用的');
  });
});
