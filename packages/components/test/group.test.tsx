// 同类合并（2026-10-28 改版稿第 2 版第 5 组）：收起一行写件数，点开是锚定浮层，每件一行。
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Group } from '../src';
import { renderUI } from './render';

const entries = [
  { key: 'a', time: '10:29', content: 'docs/designs/code-review-skill-design.md:609' },
  { key: 'b', time: '10:29', content: 'skills/team/code-review/scripts/hunks.py:35' },
  { key: 'c', time: '10:30', content: 'skills/team/code-review/SKILL.md:57' },
];

describe('Group', () => {
  it('counts the entries itself and keeps them out of the list until opened', () => {
    renderUI(<Group testID="g" tag="已加" label="行内评论" entries={entries} range="10:29–10:30" />);
    expect(screen.getByTestId('g-count').textContent).toBe('3 件 · 10:29–10:30');
    expect(screen.queryByText('skills/team/code-review/SKILL.md:57')).toBeNull();
  });

  it('opens an anchored panel with one row per entry, and closes from its header', async () => {
    renderUI(<Group testID="g" tag="已加" label="行内评论" entries={entries} />);
    fireEvent.click(screen.getByTestId('g-expand'));
    const panel = await screen.findByTestId('g-panel');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-label')).toBe('行内评论 · 3 件');
    expect(screen.getByTestId('g-list').textContent).toContain('skills/team/code-review/SKILL.md:57');
    fireEvent.click(screen.getByTestId('g-collapse'));
    expect(screen.queryByTestId('g-panel')).toBeNull();
  });
});
