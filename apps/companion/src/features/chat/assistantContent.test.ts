import { describe, expect, it } from 'vitest';

import { assistantMessageHasContent } from './assistantContent';

// 工单对话和 lead 对话共用的规则：空的文本部分不算内容（工单 #66 的 Run #71 画了一个空气泡）。
describe('assistantMessageHasContent', () => {
  const messageId = 'lead-session-1:turn_71:assistant';
  const textId = `${messageId}:text`;

  it('does not count the empty text part that every turn has', () => {
    expect(assistantMessageHasContent({
      messageId, partIds: [textId], textPart: { kind: 'text', id: textId, text: '  \n' },
    })).toBe(false);
  });

  it('counts text, and any part that is not text', () => {
    expect(assistantMessageHasContent({
      messageId, partIds: [textId], textPart: { kind: 'text', id: textId, text: '需要你验收。' },
    })).toBe(true);
    expect(assistantMessageHasContent({
      messageId, partIds: [textId, `${messageId}:tool:1`], textPart: { kind: 'text', id: textId, text: '' },
    })).toBe(true);
  });
});
