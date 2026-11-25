// 图片小图（ImageThumbnail）：外来消息卡里一排只露几张时，最后一格盖一行「+N」（工单 #529）；点了打开大图。
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ImageThumbnail } from '../src';
import { renderUI } from './render';

describe('ImageThumbnail', () => {
  it('covers the image with a short line when given one, and still opens on press', () => {
    const onPress = vi.fn();
    renderUI(<ImageThumbnail testID="thumb" size="lg" uri="data:image/png;base64,AAAA" label="Open chart.png" overlay="+2" onPress={onPress} />);
    expect(screen.getByTestId('thumb').textContent).toBe('+2');
    fireEvent.click(screen.getByTestId('thumb-open'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('has no overlay by default, in any size', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      renderUI(<ImageThumbnail testID={`thumb-${size}`} size={size} uri={null} label="image" />);
      expect(screen.getByTestId(`thumb-${size}`).textContent).toBe('');
    }
  });
});
