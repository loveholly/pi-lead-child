// 从底部升起的面板（换模型和强度）：盖住父容器，带遮罩，可以关闭。
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Button, Sheet, Text } from '../src';
import { renderUI } from './render';

function sheet(open: boolean, onClose = vi.fn()) {
  renderUI(
    <Sheet
      testID="model"
      open={open}
      onClose={onClose}
      title="换执行者的模型和强度"
      subtitle="Claude Code · 现在是 sonnet · 推理强度 high"
      closeLabel="关闭，不换"
      footer={<Button label="应用" onPress={() => {}} />}
    >
      <Text>模型</Text>
    </Sheet>,
  );
  return onClose;
}

describe('Sheet', () => {
  it('shows nothing while closed', () => {
    sheet(false);
    // Reanimated 在 web 上先把入场的元素设为 visibility: hidden，jsdom 不运行动画，所以带上 hidden。
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    expect(screen.queryByText('模型')).toBeNull();
  });

  it('is a modal dialog with its title, its content and its footer', () => {
    sheet(true);
    // 入场动画开始前元素是 hidden，可访问名称算出来是空的，所以读 aria-label。
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(dialog.getAttribute('aria-label')).toBe('换执行者的模型和强度');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Claude Code · 现在是 sonnet · 推理强度 high');
    expect(dialog.textContent).toContain('模型');
    expect(dialog.textContent).toContain('应用');
  });

  // 2026-10-21 浏览器里打开面板时报「BackHandler is not supported on web」：返回键只在 Android 上监听。
  it('opens on the web without a platform error', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      sheet(true);
      expect(error.mock.calls.map((call) => String(call[0]))).not.toContainEqual(expect.stringContaining('BackHandler'));
    } finally {
      error.mockRestore();
    }
  });

  it('closes from the close button, the scrim and Esc', () => {
    const onClose = sheet(true);
    fireEvent.click(screen.getByTestId('model-close'));
    fireEvent.click(screen.getByTestId('model-scrim'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('covers its parent and grows with its content instead of collapsing', () => {
    sheet(true);
    // 遮罩铺满父容器。
    expect(getComputedStyle(screen.getByTestId('model-scrim')).position).toBe('absolute');
    // 内容区按内容高度（不能是 flex: 0 的 0 基准），放不下时收缩，在面板里滚动。
    const body = screen.getByTestId('model-body');
    expect(body.contains(screen.getByText('模型'))).toBe(true);
    const style = getComputedStyle(body);
    expect(style.flexBasis).toBe('auto');
    expect(style.flexShrink).toBe('1');
  });
});
