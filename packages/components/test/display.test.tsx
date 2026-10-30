import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Avatar, Badge, EmptyState, Link, List, ListItem, MessageBubble, ProgressBar, safeLink, Text } from '../src';
import { renderUI } from './render';

describe('Badge', () => {
  it('shows its label and detail', () => {
    renderUI(<Badge label="#42" detail="62%" tone="success" variant="outline" size="sm" mono dot testID="chip" />);
    expect(screen.getByTestId('chip').textContent).toBe('#4262%');
  });
});

describe('Avatar', () => {
  it('shows its label', () => {
    renderUI(<Avatar label="π" testID="avatar" />);
    expect(screen.getByTestId('avatar').textContent).toBe('π');
  });

  it('centers its monogram on both axes', () => {
    renderUI(<Avatar label="π" size={28} testID="avatar" />);
    // 外层只负责定位状态圆点；第一个子元素是定宽定高的方块。
    const style = getComputedStyle(screen.getByTestId('avatar').firstElementChild!);
    expect(style.width).toBe('28px');
    expect(style.height).toBe('28px');
    expect(style.alignItems).toBe('center');
    expect(style.justifyContent).toBe('center');
  });
});

describe('MessageBubble', () => {
  it('is a light neutral bubble whose small corner points to the sender', () => {
    renderUI(<MessageBubble testID="bubble"><Text>把 #71 发布一下</Text></MessageBubble>);
    const bubble = screen.getByTestId('bubble');
    const style = getComputedStyle(bubble);
    expect(bubble.textContent).toBe('把 #71 发布一下');
    // jsdom 不解析 CSS 变量：断言底色落在 surface-muted 上，不是深色的 text。
    expect(style.backgroundColor).toBe('var(--c-surface-muted)');
    expect(style.borderTopLeftRadius).toBe('16px');
    expect(style.borderBottomLeftRadius).toBe('16px');
    expect(style.borderBottomRightRadius).toBe('4px');
  });
});

describe('ProgressBar', () => {
  it('clamps its value into 0..100', () => {
    renderUI(
      <>
        <ProgressBar value={140} testID="over" />
        <ProgressBar value={-5} testID="under" />
      </>,
    );
    expect(screen.getByTestId('over').getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByTestId('under').getAttribute('aria-valuenow')).toBe('0');
  });
});

describe('EmptyState', () => {
  it('shows its copy and runs its action', () => {
    const onPress = vi.fn();
    renderUI(<EmptyState title="没有匹配的工单" body="换个关键词试试" action={{ label: '清除筛选', onPress, testID: 'clear' }} testID="empty" />);
    expect(screen.getByTestId('empty').textContent).toContain('没有匹配的工单');
    fireEvent.click(screen.getByTestId('clear'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('List', () => {
  it('renders rows with title and subtitle and reports presses', () => {
    const onPress = vi.fn();
    renderUI(
      <List testID="projects">
        <ListItem title="移动控制面 GA" subtitle="4 工单 · 2 进行中" onPress={onPress} testID="project-row-1" />
      </List>,
    );
    expect(screen.getByTestId('project-row-1').textContent).toBe('移动控制面 GA4 工单 · 2 进行中');
    fireEvent.click(screen.getByTestId('project-row-1'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('clamps the subtitle to one line unless asked for more', () => {
    const subtitle = 'pi executor #73 汇报 · 进行中 · implementation';
    renderUI(
      <List>
        <ListItem title="单行" subtitle={subtitle} testID="one" />
        <ListItem title="两行" subtitle={subtitle} subtitleLines={2} testID="two" />
      </List>,
    );
    // Tamagui 在 web 上把 1 行渲染成不换行加省略号，多行用 -webkit-line-clamp（jsdom 读不到它，所以看是否换行）。
    const style = (testID: string) => {
      const element = [...screen.getByTestId(testID).querySelectorAll('*')].find((node) => node.textContent === subtitle)!;
      return getComputedStyle(element);
    };
    expect(style('one').whiteSpace).toBe('nowrap');
    expect(style('two').whiteSpace).not.toBe('nowrap');
    expect(style('two').overflow).toBe('hidden');
  });
});

describe('Link', () => {
  it('renders safe links as links inside text', () => {
    renderUI(<Text testID="para">见 <Link href="https://example.com" testID="link">文档</Link></Text>);
    expect(screen.getByTestId('link').getAttribute('role')).toBe('link');
    expect(screen.getByTestId('para').textContent).toBe('见 文档');
  });

  it('renders unsafe links as plain text', () => {
    renderUI(<Link href="javascript:alert(1)" testID="unsafe">x</Link>);
    expect(screen.getByTestId('unsafe').getAttribute('role')).toBeNull();
  });

  it('accepts only http(s), mailto and tel', () => {
    expect(safeLink('https://a.test')).toBe('https://a.test');
    expect(safeLink('mailto:a@b.test')).toBe('mailto:a@b.test');
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('file:///etc/passwd')).toBeNull();
    expect(safeLink('not a url')).toBeNull();
  });
});
