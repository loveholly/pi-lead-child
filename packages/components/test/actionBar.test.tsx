// 底部操作栏（下一步、更多、次要和主按钮）、对外操作前的确认，以及它们和对话坞共用一个外框。
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ActionBar, ChatDock, ConfirmBar, Text, UIProvider } from '../src';
import { renderUI } from './render';

describe('ActionBar', () => {
  it('says the next step and runs the buttons it is given', () => {
    const more = vi.fn();
    const rework = vi.fn();
    const accept = vi.fn();
    renderUI(
      <ActionBar
        testID="bar"
        next="你验收，并选好代码怎么处理"
        caption="已确认 1/3 条验收标准"
        more={{ label: '更多操作：取消工单', onPress: more }}
        secondary={{ label: '打回返工', onPress: rework }}
        primary={{ label: '验收并合并', onPress: accept }}
      />,
    );
    expect(screen.getByTestId('bar').textContent).toContain('下一步：你验收，并选好代码怎么处理');
    expect(screen.getByText('已确认 1/3 条验收标准')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更多操作：取消工单' }));
    fireEvent.click(screen.getByRole('button', { name: '打回返工' }));
    fireEvent.click(screen.getByRole('button', { name: '验收并合并' }));
    expect(more).toHaveBeenCalledTimes(1);
    expect(rework).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it('puts the text and the buttons in one row in the side panel, and stacks them on a phone', () => {
    renderUI(
      <>
        <ActionBar testID="inline" layout="inline" next="你验收" secondary={{ label: '打回返工', onPress: () => {} }} primary={{ label: '验收', onPress: () => {} }} />
        <ActionBar testID="stacked" layout="stacked" next="你验收" secondary={{ label: '打回', onPress: () => {} }} primary={{ label: '验收并合并', onPress: () => {} }} />
      </>,
    );
    expect(getComputedStyle(screen.getByTestId('inline')).flexDirection).toBe('row');
    expect(getComputedStyle(screen.getByTestId('stacked')).flexDirection).toBe('column');
    // 手机上按钮 44 高，排满一行。
    const accept = screen.getByRole('button', { name: '验收并合并' });
    expect(getComputedStyle(accept).height).toBe('44px');
    expect(getComputedStyle(accept).width).toBe('100%');
    expect(getComputedStyle(accept.parentElement!).flexGrow).toBe('1.4');
  });

  it('does not run a button the caller disabled', () => {
    const pause = vi.fn();
    renderUI(<ActionBar next="Claude Code 继续做，现在不需要你" primary={{ label: '暂停', onPress: pause, disabled: true }} />);
    const button = screen.getByRole('button', { name: '暂停' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(pause).not.toHaveBeenCalled();
  });

  it('turns into the confirmation and back', () => {
    const { rerender } = renderUI(
      <ActionBar
        testID="bar"
        next="你决定代码怎么处理"
        primary={{ label: '开草稿 PR', onPress: () => {} }}
        confirm={<ConfirmBar title="推到 GitHub，开一个草稿 PR？" confirmLabel="推送并开 PR" onConfirm={() => {}} onCancel={() => {}} />}
      />,
    );
    expect(screen.getByRole('dialog', { name: '推到 GitHub，开一个草稿 PR？' })).toBeTruthy();
    expect(screen.queryByText('你决定代码怎么处理')).toBeNull();
    expect(screen.queryByRole('button', { name: '开草稿 PR' })).toBeNull();
    rerender(<UIProvider><ActionBar testID="bar" next="你决定代码怎么处理" primary={{ label: '开草稿 PR', onPress: () => {} }} /></UIProvider>);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: '开草稿 PR' })).toBeTruthy();
  });
});

describe('ConfirmBar', () => {
  it('asks one question with the details, the note, cancel and confirm', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderUI(
      <ConfirmBar
        testID="confirm"
        title="推到 GitHub，开一个草稿 PR？"
        details={[
          { label: '推送', value: 'plc/item-102-d2d16749', mono: true },
          { label: '目标', value: 'aishx/task-model-routing', mono: true },
          { label: '内容', value: '1 个提交 · 3 个文件 · +94 · 草稿 PR，不会自动合并' },
        ]}
        note="推送是对外操作：推送以后，仓库里有权限的人都能看到这个分支和 PR。"
        confirmLabel="推送并开 PR"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: '推到 GitHub，开一个草稿 PR？' });
    expect(dialog.textContent).toContain('推送plc/item-102-d2d16749');
    expect(dialog.textContent).toContain('目标aishx/task-model-routing');
    expect(dialog.textContent).toContain('推送是对外操作');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '推送并开 PR' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does not confirm twice while the request is on its way', () => {
    const onConfirm = vi.fn();
    renderUI(<ConfirmBar title="不等核查，直接验收？" confirmLabel="直接验收" onConfirm={onConfirm} onCancel={() => {}} busy />);
    fireEvent.click(screen.getByRole('button', { name: '直接验收' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('ChatDock with an action bar', () => {
  it('puts the bar above the conversation header in the same frame, and the header still toggles', () => {
    const onExpandedChange = vi.fn();
    renderUI(
      <ChatDock
        testID="dock"
        expanded={false}
        onExpandedChange={onExpandedChange}
        title="工单对话"
        composer={<Text>输入框</Text>}
        bar={<ActionBar next="你验收" primary={{ label: '验收', onPress: () => {} }} />}
      />,
    );
    const dock = screen.getByTestId('dock');
    const bar = screen.getByTestId('dock-bar');
    const toggle = screen.getByTestId('dock-toggle');
    expect(dock.contains(bar)).toBe(true);
    // 操作栏在标题行前面。
    expect(bar.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.textContent).toContain('下一步：你验收');
    expect(toggle.textContent).not.toContain('下一步');
    fireEvent.click(toggle);
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });
});
