// 从页面里一块内容原来的位置打开的浮层（2026-10-17，会话方案第五版的合一工单卡）。
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { AnchoredPanel, Pressable, Text } from '../src';
import { renderUI } from './render';

function Harness({ body = <Text>浮层的正文</Text> }: { body?: ReactNode } = {}) {
  const [open, setOpen] = useState(false);
  return (
    <AnchoredPanel
      testID="card"
      open={open}
      onClose={() => setOpen(false)}
      label="#77 的进展"
      header={<Text>浮层的头</Text>}
      body={body}
    >
      <Pressable aria-label="展开" onPress={() => setOpen(true)}><Text>收着的卡片</Text></Pressable>
    </AnchoredPanel>
  );
}

describe('AnchoredPanel', () => {
  it('keeps the collapsed content in place and shows nothing else while closed', () => {
    renderUI(<Harness />);
    expect(screen.getByText('收着的卡片')).toBeTruthy();
    expect(screen.queryByTestId('card-panel')).toBeNull();
  });

  it('opens a dialog with the header and the body over the content, and closes from outside', async () => {
    renderUI(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    const dialog = await screen.findByTestId('card-panel');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('#77 的进展');
    expect(screen.getByText('浮层的头')).toBeTruthy();
    expect(screen.getByText('浮层的正文')).toBeTruthy();
    // 卡片本身还在原位：浮层不把它挪走。
    expect(screen.getByText('收着的卡片')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByTestId('card-panel')).toBeNull();
  });

  // 2026-10-27：child 来信的回答里有一张宽表。浮层打开时 react-native-web 的 Modal 把焦点交给第一个能聚焦的元素，
  // 落在表格的横向滚动区上，Chrome 给它画了一圈橙色焦点框。焦点应该落在浮层自己身上（对话框的通常做法），不画框。
  it('puts focus on the dialog itself, not on the first focusable thing inside it', async () => {
    renderUI(<Harness body={<Pressable aria-label="正文里的按钮" onPress={() => {}}><Text>按钮</Text></Pressable>} />);
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    const dialog = await screen.findByTestId('card-panel');
    await waitFor(() => expect(document.activeElement).toBe(dialog));
  });
});
