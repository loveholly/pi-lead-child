import { describe, expect, it } from 'vitest';

import { KEEP_ORIGINAL_MAX_BYTES, planChatImage } from './chatImagePicker.types';

// 选中或粘贴的图片怎么处理：格式模型收、长边不超过 1568、不太大的原样发（截图里的字保持清楚）；别的缩到长边 1568 以内重新编码。
describe('planChatImage', () => {
  it('keeps a small image of an accepted format as it is', () => {
    expect(planChatImage({ mimeType: 'image/png', bytes: 200_000, width: 1440, height: 900 }))
      .toEqual({ keep: true, mimeType: 'image/png' });
    expect(planChatImage({ mimeType: 'image/gif', bytes: 50_000, width: 400, height: 300 }))
      .toEqual({ keep: true, mimeType: 'image/gif' });
  });

  it('scales a large screenshot down to a 1568 pixel long edge, keeping its shape', () => {
    expect(planChatImage({ mimeType: 'image/png', bytes: 3_000_000, width: 2880, height: 1800 }))
      .toEqual({ keep: false, width: 1568, height: 980 });
    expect(planChatImage({ mimeType: 'image/jpeg', bytes: 900_000, width: 3024, height: 4032 }))
      .toEqual({ keep: false, width: 1176, height: 1568 });
  });

  it('re-encodes a heavy image at its size, and a format the model services do not take', () => {
    expect(planChatImage({ mimeType: 'image/png', bytes: KEEP_ORIGINAL_MAX_BYTES + 1, width: 1200, height: 800 }))
      .toEqual({ keep: false, width: 1200, height: 800 });
    expect(planChatImage({ mimeType: 'image/heic', bytes: 100_000, width: 800, height: 600 }))
      .toEqual({ keep: false, width: 800, height: 600 });
  });
});
