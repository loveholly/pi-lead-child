// 聊天列表（ChatList）：主会话和工单对话共用。happy-dom 量不出行高（test/domShims.ts 去掉了它的 ResizeObserver），列表不虚拟化，
// 每一块都画出来：会话的测试照样看得到每一条消息。
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ChatList, Text } from '../src';
import { cssVar, renderUI } from './render';

type Block = { id: string; text: string };
const blocks: Block[] = [{ id: 'a', text: '第一块' }, { id: 'b', text: '第二块' }, { id: 'c', text: '第三块' }];

describe('the chat list where rows cannot be measured', () => {
  it('draws every block in order, with the conversation gap between blocks and none after the last', () => {
    renderUI(
      <ChatList
        testID="chat"
        data={blocks}
        keyExtractor={(block) => block.id}
        renderItem={(block) => <Text testID={`block-${block.id}`}>{block.text}</Text>}
        header={<Text testID="header">上面</Text>}
        footer={<Text testID="footer">下面</Text>}
      />,
    );
    const text = screen.getByTestId('chat').textContent;
    expect(text).toBe('上面第一块第二块第三块下面');
    const gaps = screen.getAllByTestId('chat-gap');
    expect(gaps).toHaveLength(2);
    for (const gap of gaps) expect(getComputedStyle(gap).paddingTop).toBe(cssVar('--t-space-conversation-block'));
  });

  it('shows the empty state when there is no block', () => {
    renderUI(
      <ChatList
        testID="chat"
        data={[] as Block[]}
        keyExtractor={(block) => block.id}
        renderItem={(block) => <Text>{block.text}</Text>}
        empty={<Text testID="empty">还没有消息</Text>}
      />,
    );
    expect(screen.getByTestId('empty')).toBeTruthy();
    expect(screen.queryAllByTestId('chat-gap')).toHaveLength(0);
  });

  // 根因（2026-10-16）：内容区写了 flex 1，react-native-web 给它 flex-basis 0，内容缩成一屏高，滚不动。
  it('lets the content grow past the viewport and never shrinks it, so a long conversation scrolls', () => {
    renderUI(
      <ChatList testID="chat" data={blocks} keyExtractor={(block) => block.id} renderItem={(block) => <Text>{block.text}</Text>} />,
    );
    const content = screen.getByTestId('chat-scroller').firstElementChild as HTMLElement;
    const column = content.firstElementChild as HTMLElement;
    expect(getComputedStyle(column).flexGrow).toBe('1');
    expect(getComputedStyle(column).flexShrink).toBe('0');
    expect(getComputedStyle(column).flexBasis).toBe('auto');
    expect(getComputedStyle(column).justifyContent).toBe('flex-end');
  });
});
