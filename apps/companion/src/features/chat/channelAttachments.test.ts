// 外来消息正文里的文件标记（工单 #529）：认出图片和文件，别的标记照旧是字；取不到的图片放回原来的位置。
import { describe, expect, it } from 'vitest';

import { channelMessageParts, channelMessageText } from './channelAttachments';

describe('the file markers in a message', () => {
  it('finds images and files in their own lines, in order, and keeps the rest as text', () => {
    const text = [
      '前后端都发布了 CC @Sam',
      '[图片 image.png，文件编号 slack:F0DEMO0001]',
      '[文件 report.pdf，application/pdf，文件编号 slack:F0DEMO0009]',
      '[图片 a，b.png，文件编号 slack:F0DEMO0002]',
      '后面还有一句',
    ].join('\n');
    const parts = channelMessageParts(text);
    expect(parts.images).toEqual([
      { fileId: 'slack:F0DEMO0001', name: 'image.png', marker: '[图片 image.png，文件编号 slack:F0DEMO0001]' },
      { fileId: 'slack:F0DEMO0002', name: 'a，b.png', marker: '[图片 a，b.png，文件编号 slack:F0DEMO0002]' },
    ]);
    expect(parts.files).toEqual([{
      fileId: 'slack:F0DEMO0009', name: 'report.pdf', mimeType: 'application/pdf',
      marker: '[文件 report.pdf，application/pdf，文件编号 slack:F0DEMO0009]',
    }]);
    expect(parts.lines.map((line) => line.kind)).toEqual(['text', 'image', 'file', 'image', 'text']);
    expect(channelMessageText(parts)).toBe('前后端都发布了 CC @Sam\n后面还有一句');
  });

  it('reads a file without a type', () => {
    expect(channelMessageParts('[文件 notes，文件编号 slack:F0DEMO0003]').files).toEqual([
      { fileId: 'slack:F0DEMO0003', name: 'notes', mimeType: null, marker: '[文件 notes，文件编号 slack:F0DEMO0003]' },
    ]);
  });

  it('leaves markers without a Slack file id as text: outside images, hidden files, and look-alikes', () => {
    const text = [
      '[图片 卡片里的外链图片，不是 Slack 文件，没有文件编号：https://example.com/cover.png]',
      '[文件 看不到：超出了工作区的存储上限]',
      '[图片 x.png，文件编号 slack:../../etc/passwd]',
      '[图片 x.png，文件编号 https://example.com/x.png]',
      '[图片 x.png，文件编号 slack:f0lower]',
      '看这个 [图片 x.png，文件编号 slack:F0DEMO0004] 在句子中间',
    ].join('\n');
    const parts = channelMessageParts(text);
    expect(parts.images).toEqual([]);
    expect(parts.files).toEqual([]);
    expect(channelMessageText(parts)).toBe(text);
  });

  it('puts the marker of an image that could not be loaded back where it was', () => {
    const parts = channelMessageParts('看图\n[图片 a.png，文件编号 slack:F0A]\n[图片 b.png，文件编号 slack:F0B]\n就这些');
    expect(channelMessageText(parts, new Set(['slack:F0A']))).toBe('看图\n[图片 a.png，文件编号 slack:F0A]\n就这些');
    // 只有图片的消息：图片都在时没有字。
    expect(channelMessageText(channelMessageParts('[图片 a.png，文件编号 slack:F0A]'))).toBe('');
  });
});
