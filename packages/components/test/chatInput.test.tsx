// 会话输入框的文字输入（2026-10-25）：Enter 发送，Shift+Enter 换行，输入法组字时的 Enter 不发送；
// 剪贴板里只有图片时，粘贴交给 onPasteFiles；缺省一行高，内容多了长高，到 8 行以后在框里滚动。
import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ChatInput, ImageThumbnail } from '../src';
import { renderUI } from './render';

function Controlled(props: { onSubmit?: () => void; onPasteFiles?: (files: Blob[]) => void; disabled?: boolean }) {
  const [value, setValue] = useState('');
  return <ChatInput value={value} onChangeText={setValue} placeholder="给 Fairy 发消息" testID="input" {...props} />;
}

const textarea = () => screen.getByTestId('input') as HTMLTextAreaElement;
// fireEvent 返回 false 表示事件被 preventDefault：浏览器不会再插入换行或粘贴。
const keyDown = (init: KeyboardEventInit & { keyCode?: number }) => fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter', ...init });

describe('ChatInput', () => {
  it('is a one-line textarea with the placeholder', () => {
    renderUI(<Controlled />);
    expect(textarea().tagName).toBe('TEXTAREA');
    expect(textarea().placeholder).toBe('给 Fairy 发消息');
    // happy-dom 的 rows 是字符串（浏览器里是数），读属性。
    expect(textarea().getAttribute('rows')).toBe('1');
  });

  it('submits on Enter instead of inserting a newline', () => {
    const onSubmit = vi.fn();
    renderUI(<Controlled onSubmit={onSubmit} />);
    expect(keyDown({ keyCode: 13 })).toBe(false);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('inserts a newline on Shift+Enter', () => {
    const onSubmit = vi.fn();
    renderUI(<Controlled onSubmit={onSubmit} />);
    expect(keyDown({ keyCode: 13, shiftKey: true })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not submit on the Enter that confirms an input method candidate', () => {
    const onSubmit = vi.fn();
    renderUI(<Controlled onSubmit={onSubmit} />);
    expect(keyDown({ keyCode: 13, isComposing: true })).toBe(true);
    // Safari 在组字结束的那次按键上 isComposing 已经是 false，keyCode 是 229。
    expect(keyDown({ keyCode: 229 })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not submit while disabled, and still keeps Enter from inserting a newline', () => {
    const onSubmit = vi.fn();
    renderUI(<Controlled onSubmit={onSubmit} disabled />);
    expect(keyDown({ keyCode: 13 })).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('hands pasted images to onPasteFiles when the clipboard has no text', () => {
    const onPasteFiles = vi.fn();
    renderUI(<Controlled onPasteFiles={onPasteFiles} />);
    const image = new File([new Uint8Array([0x89, 0x50])], 'screenshot.png', { type: 'image/png' });
    const pasted = fireEvent.paste(textarea(), {
      clipboardData: {
        getData: () => '',
        items: [
          { kind: 'file', type: 'image/png', getAsFile: () => image },
          { kind: 'string', type: 'text/html', getAsFile: () => null },
        ],
        files: [image],
      },
    });
    expect(pasted).toBe(false);
    expect(onPasteFiles).toHaveBeenCalledWith([image]);
  });

  it('lets text paste as text, even when the clipboard also has an image', () => {
    const onPasteFiles = vi.fn();
    renderUI(<Controlled onPasteFiles={onPasteFiles} />);
    const image = new File([new Uint8Array([0x89, 0x50])], 'cells.png', { type: 'image/png' });
    const pasted = fireEvent.paste(textarea(), {
      clipboardData: {
        getData: (type: string) => (type === 'text/plain' ? 'A1\tB1' : ''),
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
        files: [image],
      },
    });
    expect(pasted).toBe(true);
    expect(onPasteFiles).not.toHaveBeenCalled();
  });

  it('grows with its content up to 8 lines, then scrolls', () => {
    let content = 24;
    const spy = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => content);
    try {
      renderUI(<Controlled />);
      expect(textarea().style.height).toBe('24px');
      expect(textarea().style.overflowY).toBe('hidden');
      content = 72;
      fireEvent.change(textarea(), { target: { value: '一\n二\n三' } });
      expect(textarea().style.height).toBe('72px');
      content = 400;
      fireEvent.change(textarea(), { target: { value: '很多行'.repeat(40) } });
      expect(textarea().style.height).toBe('192px');
      expect(textarea().style.overflowY).toBe('auto');
      content = 24;
      fireEvent.change(textarea(), { target: { value: '' } });
      expect(textarea().style.height).toBe('24px');
    } finally {
      spy.mockRestore();
    }
  });

  // 工单 #264：以前每输入一个字，先把输入框的高度清零再量。清零那一刻会话列表的可视区变高，贴底的列表被浏览器往下拉了一截。
  // 现在在影子 textarea 里量：页面上的输入框只在高度真的变了时写一次，不经过更矮的高度。
  it('measures without shrinking the visible input first', () => {
    let content = 48;
    const spy = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => content);
    try {
      renderUI(<Controlled />);
      fireEvent.change(textarea(), { target: { value: '第一行很长，折到了第二行' } });
      expect(textarea().style.height).toBe('48px');
      const heights = recordHeights(textarea(), () => {
        fireEvent.change(textarea(), { target: { value: '第一行很长，折到了第二行，又多打了几个字' } });
        content = 72;
        fireEvent.change(textarea(), { target: { value: '第一行很长，折到了第二行，又多打了几个字，到了第三行' } });
      });
      // 两行时再打字：高度不写；长到三行：从 48 直接写成 72。
      expect(heights).toEqual(['72px']);
    } finally {
      spy.mockRestore();
    }
  });

  it('removes its measuring textarea when it unmounts', () => {
    const view = renderUI(<Controlled />);
    const shadows = () => [...document.body.querySelectorAll<HTMLTextAreaElement>('textarea[aria-hidden="true"]')];
    expect(shadows()).toHaveLength(1);
    expect(shadows()[0]!.style.visibility).toBe('hidden');
    view.unmount();
    expect(shadows()).toHaveLength(0);
  });
});

// 在 run 里依次写给 node 的高度（style.height 的每一次改动）。
function recordHeights(node: HTMLElement, run: () => void): string[] {
  const observer = new MutationObserver(() => {});
  observer.observe(node, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
  const before = node.style.height;
  run();
  const records = observer.takeRecords();
  observer.disconnect();
  // 每条记录的 oldValue 是改之前的 style；连起来再加上最后的值，就是高度依次经过的值。
  const values = [...records.map((record) => heightIn(record.oldValue)), node.style.height];
  const heights: string[] = [];
  let previous = before;
  for (const value of values.slice(1)) {
    if (value !== previous) heights.push(value);
    previous = value;
  }
  return heights;
}

function heightIn(style: string | null): string {
  const probe = document.createElement('div');
  probe.setAttribute('style', style ?? '');
  return probe.style.height;
}

describe('ImageThumbnail', () => {
  it('shows the image in a 64×64 box and removes it from the corner button', () => {
    const onRemove = vi.fn();
    renderUI(<ImageThumbnail uri="data:image/png;base64,iVBORw0KGgo=" label="图片 1" onRemove={onRemove} removeLabel="移除图片 1" testID="thumb" />);
    const box = screen.getByTestId('thumb');
    expect(box.getAttribute('aria-label')).toBe('图片 1');
    expect(getComputedStyle(box).width).toBe('64px');
    expect(getComputedStyle(box).height).toBe('64px');
    expect(box.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    const remove = screen.getByTestId('thumb-remove');
    expect(remove.getAttribute('aria-label')).toBe('移除图片 1');
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('has no remove button when nothing can remove it', () => {
    renderUI(<ImageThumbnail uri={null} label="你发的图片 1" testID="thumb" />);
    expect(screen.queryByTestId('thumb-remove')).toBeNull();
  });
});
