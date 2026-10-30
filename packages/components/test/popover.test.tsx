// 浮层（Popover）：宽屏时浮在触发按钮下面，手机宽度时是底部面板。2026-10-16 用户要求会话里的「依据」标签可以点开。
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Popover, Text } from '../src';
import { renderUI } from './render';

describe('Popover', () => {
  it('opens a dialog from its trigger and closes it again', async () => {
    renderUI(
      <Popover label="依据：等你处理的工单，查看来源" title="依据：等你处理的工单" trigger={<Text>依据：等你处理的工单</Text>} testID="sources">
        <Text>#1 成果快照与登记机制</Text>
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: '依据：等你处理的工单，查看来源' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('#1 成果快照与登记机制')).toBeNull();

    fireEvent.click(trigger);
    expect(await screen.findByTestId('sources-panel')).toBeTruthy();
    expect(screen.getByText('#1 成果快照与登记机制')).toBeTruthy();
    expect(screen.getByRole('button', { name: '依据：等你处理的工单，查看来源' }).getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getAllByRole('button', { name: '关闭' }).at(-1)!);
    await waitFor(() => expect(screen.queryByText('#1 成果快照与登记机制')).toBeNull());
  });

  it('lets the content close it, for a row that navigates away', async () => {
    renderUI(
      <Popover label="打开" trigger={<Text>打开</Text>} testID="sources">
        {(close) => <Text onPress={close}>去工单</Text>}
      </Popover>,
    );
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    fireEvent.click(await screen.findByText('去工单'));
    await waitFor(() => expect(screen.queryByText('去工单')).toBeNull());
  });
});
