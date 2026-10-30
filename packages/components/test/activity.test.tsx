// 用户操作的订阅：应用据此判断"最近有没有人在看"（见 companion 的 AttendanceTracker）。
// web 上订阅 document 的点按、键盘、触摸和滚动；ActivityBoundary 在 web 上不加任何元素。
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ActivityBoundary, subscribeUserActivity } from '../src';

describe('subscribeUserActivity on web', () => {
  it('reports pointer, keyboard, touch and wheel input until unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUserActivity(listener);
    for (const type of ['pointerdown', 'keydown', 'touchstart', 'wheel']) document.dispatchEvent(new Event(type));
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    document.dispatchEvent(new Event('keydown'));
    expect(listener).toHaveBeenCalledTimes(4);
  });
});

describe('ActivityBoundary on web', () => {
  it('adds no element around its children', () => {
    const { container } = render(<ActivityBoundary><span data-testid="child">hi</span></ActivityBoundary>);
    expect(container.firstElementChild?.tagName).toBe('SPAN');
  });
});
