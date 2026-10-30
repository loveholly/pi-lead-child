// 对话坞：收起时露出最新一条和输入框，展开时对话占满面板（工单详情方案 D）。
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChatDock, DockedLayout, Text, UIProvider } from '../src';
import { CHAT_DOCK_SWIPE_DISTANCE, chatDockSwipe } from '../src/display/ChatDockFrame';
import { DOCK_EXPAND_MS, dockPhase } from '../src/display/dockMotion';
import { renderUI } from './render';

function dock(props: Partial<Parameters<typeof ChatDock>[0]> = {}) {
  const onExpandedChange = vi.fn();
  renderUI(
    <ChatDock
      testID="dock"
      expanded={false}
      onExpandedChange={onExpandedChange}
      title="工单对话"
      count="8"
      preview={<Text>执行 agent · 17:58 我建议派一次新的核查</Text>}
      composer={<Text>输入框</Text>}
      {...props}
    >
      <Text>全部对话</Text>
    </ChatDock>,
  );
  return onExpandedChange;
}

describe('ChatDock', () => {
  it('shows the latest message and the composer while collapsed, not the conversation', () => {
    dock();
    expect(screen.getByTestId('dock-preview').textContent).toContain('我建议派一次新的核查');
    expect(screen.getByText('输入框')).toBeTruthy();
    expect(screen.queryByText('全部对话')).toBeNull();
    const toggle = screen.getByTestId('dock-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBeNull();
    expect(toggle.textContent).toContain('工单对话');
    expect(toggle.textContent).toContain('8');
    expect(toggle.textContent).toContain('展开');
  });

  it('keeps its content height while collapsed instead of collapsing to a line', () => {
    // react-native-web 把 flex={0} 展开成 flex: 0 1 0%：基准为 0 的对话坞在真实浏览器里只剩 1px 高。
    dock();
    const style = getComputedStyle(screen.getByTestId('dock'));
    expect(style.flexBasis).toBe('auto');
    expect(style.flexShrink).toBe('0');
  });

  it('expands from the header button and from the preview', () => {
    const onExpandedChange = dock();
    fireEvent.click(screen.getByTestId('dock-toggle'));
    fireEvent.click(screen.getByTestId('dock-preview'));
    expect(onExpandedChange.mock.calls).toEqual([[true], [true]]);
  });

  it('shows the conversation and keeps the composer while expanded', () => {
    const onExpandedChange = dock({ expanded: true });
    const toggle = screen.getByTestId('dock-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(screen.getByTestId('dock-body').id);
    expect(screen.getByText('全部对话')).toBeTruthy();
    expect(screen.getByText('输入框')).toBeTruthy();
    expect(screen.queryByTestId('dock-preview')).toBeNull();
    expect(toggle.textContent).toContain('收起');
    fireEvent.click(toggle);
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it('collapses on Escape only while expanded', () => {
    const collapsed = dock();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(collapsed).not.toHaveBeenCalled();
  });

  it('collapses on Escape while expanded', () => {
    const onExpandedChange = dock({ expanded: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it('marks unread content only while collapsed', () => {
    dock({ unread: true, unreadLabel: '新回复' });
    expect(screen.getByTestId('dock-toggle').textContent).toContain('新回复');
  });

  it('does not mark unread content while expanded', () => {
    dock({ unread: true, unreadLabel: '新回复', expanded: true });
    expect(screen.getByTestId('dock-toggle').textContent).not.toContain('新回复');
  });
});

describe('DockedLayout', () => {
  it('hides the main area while the dock is expanded, without unmounting it', () => {
    renderUI(
      <DockedLayout testID="panel" expanded dock={<Text>坞</Text>}>
        <Text>概览</Text>
      </DockedLayout>,
    );
    const main = screen.getByTestId('panel-main');
    expect(main.textContent).toBe('概览');
    expect(getComputedStyle(main).display).toBe('none');
    expect(main.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the main area while the dock is collapsed', () => {
    renderUI(
      <DockedLayout testID="panel" expanded={false} dock={<Text>坞</Text>}>
        <Text>概览</Text>
      </DockedLayout>,
    );
    const main = screen.getByTestId('panel-main');
    expect(getComputedStyle(main).display).not.toBe('none');
    expect(main.getAttribute('aria-hidden')).toBeNull();
  });
});

// 2026-10-16：展开和收起有动画。对话坞的上沿滑上去、滑下来，预览淡出、对话淡入。
function dockedPanel(expanded: boolean) {
  return (
    <UIProvider>
      <DockedLayout
        testID="panel"
        expanded={expanded}
        dock={(
          <ChatDock
            testID="dock"
            expanded={expanded}
            onExpandedChange={() => {}}
            title="工单对话"
            preview={<Text>执行 agent · 17:58 我建议派一次新的核查</Text>}
            composer={<Text>输入框</Text>}
          >
            <Text>全部对话</Text>
          </ChatDock>
        )}
      >
        <Text>概览</Text>
      </DockedLayout>
    </UIProvider>
  );
}

describe('animating the chat dock', () => {
  it('names the four phases from the expanded state and whether the animation ended', () => {
    expect(dockPhase(false, true)).toBe('collapsed');
    expect(dockPhase(true, false)).toBe('expanding');
    expect(dockPhase(true, true)).toBe('expanded');
    expect(dockPhase(false, false)).toBe('collapsing');
  });

  it('splits the free height by progress, so the dock grows from its own content height', () => {
    render(dockedPanel(false));
    const main = getComputedStyle(screen.getByTestId('panel-main'));
    const slot = getComputedStyle(screen.getByTestId('panel-dock'));
    // 主体基准 0、按 1 - 进度伸展；对话坞的格子以内容高度为基准、按进度伸展，不收缩。
    expect(main.flexBasis).toBe('0px');
    expect(main.flexGrow).toBe('1');
    expect(slot.flexBasis).toBe('auto');
    expect(slot.flexShrink).toBe('0');
    expect(slot.flexGrow).toBe('0');
    // 对话坞填满它的格子，基准仍是内容高度：不然格子量不到收起时的高度。
    const frame = getComputedStyle(screen.getByTestId('dock'));
    expect(frame.flexGrow).toBe('1');
    expect(frame.flexBasis).toBe('auto');
  });

  it('keeps the preview and mounts the conversation while expanding, then drops the preview', async () => {
    const { rerender } = render(dockedPanel(false));
    rerender(dockedPanel(true));
    // 动画中：按钮马上说「收起」，对话已经在（从 0 高长出来），预览还在（淡出）。主体还看得见，但无障碍服务不再读它。
    const toggle = screen.getByTestId('dock-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('收起');
    expect(screen.getByText('全部对话')).toBeTruthy();
    expect(screen.getByTestId('dock-preview')).toBeTruthy();
    const main = screen.getByTestId('panel-main');
    expect(getComputedStyle(main).display).not.toBe('none');
    expect(main.getAttribute('aria-hidden')).toBe('true');
    // 对话区的基准是 0：动画开始时它不把对话坞撑高。
    const body = screen.getByTestId('dock-body').parentElement!;
    expect(getComputedStyle(body).flexBasis).toBe('0px');

    // 动画播完：预览卸载，主体藏起来，空余的高度全给对话坞。
    await waitFor(() => expect(screen.queryByTestId('dock-preview')).toBeNull(), { timeout: DOCK_EXPAND_MS * 4 });
    expect(getComputedStyle(main).display).toBe('none');
    // 最后一帧的样式在下一帧写上。
    await waitFor(() => expect(getComputedStyle(screen.getByTestId('panel-dock')).flexGrow).toBe('1'));
    expect(getComputedStyle(main).flexGrow).toBe('0');
  });

  it('shows the main area at once when collapsing and unmounts the conversation after the slide', async () => {
    const { rerender } = render(dockedPanel(true));
    expect(getComputedStyle(screen.getByTestId('panel-main')).display).toBe('none');
    rerender(dockedPanel(false));
    const main = screen.getByTestId('panel-main');
    expect(getComputedStyle(main).display).not.toBe('none');
    expect(main.getAttribute('aria-hidden')).toBeNull();
    // 对话还在（淡出），但已经不算展开的区域；预览回来了（淡入）。
    expect(screen.getByTestId('dock-body').parentElement!.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('dock-toggle').getAttribute('aria-controls')).toBeNull();
    expect(screen.getByTestId('dock-preview')).toBeTruthy();

    await waitFor(() => expect(screen.queryByText('全部对话')).toBeNull(), { timeout: DOCK_EXPAND_MS * 4 });
    expect(screen.getByTestId('dock-preview')).toBeTruthy();
    await waitFor(() => expect(getComputedStyle(main).flexGrow).toBe('1'));
    expect(getComputedStyle(screen.getByTestId('panel-dock')).flexGrow).toBe('0');
  });

  it('turns back from where it is when you collapse it halfway through expanding', async () => {
    const { rerender } = render(dockedPanel(false));
    rerender(dockedPanel(true));
    await new Promise((resolve) => setTimeout(resolve, DOCK_EXPAND_MS / 3));
    const halfway = Number(getComputedStyle(screen.getByTestId('panel-dock')).flexGrow);
    expect(halfway).toBeGreaterThan(0);
    expect(halfway).toBeLessThan(1);
    rerender(dockedPanel(false));
    // 被打断的展开不会落到「展开」：对话最后卸载，主体一直看得见。
    await waitFor(() => expect(screen.queryByText('全部对话')).toBeNull(), { timeout: DOCK_EXPAND_MS * 4 });
    expect(getComputedStyle(screen.getByTestId('panel-main')).display).not.toBe('none');
    expect(screen.getByTestId('dock-preview')).toBeTruthy();
    await waitFor(() => expect(getComputedStyle(screen.getByTestId('panel-dock')).flexGrow).toBe('0'));
  });
});

describe('swiping the chat dock', () => {
  it('expands on a swipe up and collapses on a swipe down', () => {
    expect(chatDockSwipe(false, -CHAT_DOCK_SWIPE_DISTANCE)).toBe(true);
    expect(chatDockSwipe(true, CHAT_DOCK_SWIPE_DISTANCE)).toBe(false);
  });

  it('ignores short moves and swipes toward the state it already has', () => {
    expect(chatDockSwipe(false, -(CHAT_DOCK_SWIPE_DISTANCE - 1))).toBeNull();
    expect(chatDockSwipe(false, 80)).toBeNull();
    expect(chatDockSwipe(true, -80)).toBeNull();
  });
});
