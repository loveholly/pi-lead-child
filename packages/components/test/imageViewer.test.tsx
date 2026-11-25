// 全屏看大图（ImageViewer）：通用组件，谁给图片谁用。关着时什么都不画；开着时是一个模态对话框，
// 顶上是关闭和「1 / 3」，web 上有上一张、下一张和方向键；调用方给的操作拿到当前这一张的序号；删到一张不剩时自己关上。
import { act, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ImageViewer, type ImageViewerItem } from '../src';
import { renderUI } from './render';

const items: ImageViewerItem[] = [
  { key: 'a', uri: 'data:image/png;base64,AAAA', label: 'first.png' },
  { key: 'b', uri: 'data:image/png;base64,BBBB', label: 'second.png' },
  { key: 'c', uri: null, label: 'third.png', failed: true },
];

describe('ImageViewer', () => {
  it('shows nothing while closed', () => {
    renderUI(<ImageViewer testID="viewer" open={false} items={items} onClose={() => {}} />);
    expect(screen.queryByTestId('viewer')).toBeNull();
  });

  it('opens on the given image, says which one it is, and closes', () => {
    const onClose = vi.fn();
    renderUI(<ImageViewer testID="viewer" open items={items} initialIndex={1} onClose={onClose} />);
    const dialog = screen.getByTestId('viewer');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Image 2 of 3, second.png');
    expect(screen.getByTestId('viewer-count').textContent).toBe('2 / 3');
    fireEvent.click(screen.getByTestId('viewer-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves between images with the buttons and the arrow keys on the web', () => {
    renderUI(<ImageViewer testID="viewer" open items={items} onClose={() => {}} />);
    expect(screen.queryByTestId('viewer-previous')).toBeNull();
    fireEvent.click(screen.getByTestId('viewer-next'));
    expect(screen.getByTestId('viewer-count').textContent).toBe('2 / 3');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })); });
    expect(screen.getByTestId('viewer-count').textContent).toBe('3 / 3');
    expect(screen.queryByTestId('viewer-next')).toBeNull();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })); });
    expect(screen.getByTestId('viewer-count').textContent).toBe('2 / 3');
  });

  it('shows no counter and no arrows for a single image', () => {
    renderUI(<ImageViewer testID="viewer" open items={items.slice(0, 1)} onClose={() => {}} />);
    expect(screen.queryByTestId('viewer-count')).toBeNull();
    expect(screen.queryByTestId('viewer-next')).toBeNull();
  });

  it('gives an action the index of the image on screen, and closes when the last image is removed', () => {
    const onClose = vi.fn();
    function Harness() {
      const [list, setList] = useState(items.slice(0, 2));
      return (
        <ImageViewer
          testID="viewer"
          open
          items={list}
          initialIndex={1}
          onClose={onClose}
          actions={[{ id: 'remove', label: 'Remove this image', icon: 'trash', onPress: (index) => setList((old) => old.filter((_, i) => i !== index)) }]}
        />
      );
    }
    renderUI(<Harness />);
    fireEvent.click(screen.getByTestId('viewer-action-remove'));
    // second.png 删掉了，留下 first.png，序号退回到它。
    expect(screen.getByTestId('viewer').getAttribute('aria-label')).toBe('Image 1 of 1, first.png');
    fireEvent.click(screen.getByTestId('viewer-action-remove'));
    expect(onClose).toHaveBeenCalled();
  });

  // 外来消息卡的图片（工单 #529）：点图外面的黑底关上，点图片本身不关；「1 / 3」写在下面、操作的上面。
  it('closes on the backdrop but not on the image when asked, and can put the counter at the bottom', () => {
    const onClose = vi.fn();
    renderUI(
      <ImageViewer
        testID="viewer"
        open
        items={items.slice(0, 2)}
        onClose={onClose}
        closeOnBackdrop
        counterPosition="bottom"
        actions={[{ id: 'open', label: 'Open in Slack', icon: 'arrow-up-right', onPress: () => {} }]}
      />,
    );
    fireEvent.click(screen.getByTestId('viewer-page-0-image'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('viewer-page-0-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
    const count = screen.getByTestId('viewer-count');
    expect(count.textContent).toBe('1 / 2');
    // 计数在操作的前面（同一个底部区域里）。
    const action = screen.getByTestId('viewer-action-open');
    expect(count.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps tapping anywhere as the zoom gesture by default', () => {
    const onClose = vi.fn();
    renderUI(<ImageViewer testID="viewer" open items={items.slice(0, 2)} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('viewer-page-0-backdrop'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('viewer-page-0-image')).toBeNull();
  });
});
