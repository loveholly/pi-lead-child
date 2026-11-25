// 外来消息正文里的文件标记（工单 #529）。
//
// daemon 收 Slack 消息时，把附带的文件写成正文里单独的一行（engine 的 sources/slack.ts 的 slackFileLine）：
//   图片：「[图片 a.png，文件编号 slack:F0123]」
//   文件：「[文件 report.pdf，application/pdf，文件编号 slack:F0456]」（类型可能没有）
// 存进事件的正文和 Lead 读到的都是这几行字，不改。卡片画的时候把它们认出来：图片画成缩略图，文件画成小标签。
// 别的标记（卡片里的外链图片、超出存储上限看不到的文件）不是 Slack 文件，没有文件编号，照旧是文字。

// 和 protocol 的 CHANNEL_FILE_ID_PATTERN 一样：只认 Slack 的文件编号。
const FILE_ID = 'slack:F[A-Z0-9]{1,30}';
const IMAGE_MARKER = new RegExp(`^\\[图片 (.+)，文件编号 (${FILE_ID})\\]$`);
const FILE_MARKER = new RegExp(`^\\[文件 (.+)，文件编号 (${FILE_ID})\\]$`);
// 文件标记里名字后面的 MIME 类型（「，application/pdf」）。
const MIME_SUFFIX = /，([a-z0-9][a-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+_-]*)$/;

export type ChannelImageRef = { fileId: string; name: string; marker: string };
export type ChannelFileRef = { fileId: string; name: string; mimeType: string | null; marker: string };

// 正文按行分开：普通的字、图片、文件，保持原来的顺序（图片取不到时把标记放回原来的位置）。
export type ChannelMessageLine =
  | { kind: 'text'; text: string }
  | { kind: 'image'; image: ChannelImageRef }
  | { kind: 'file'; file: ChannelFileRef };

export type ChannelMessageParts = {
  lines: ChannelMessageLine[];
  images: ChannelImageRef[];
  files: ChannelFileRef[];
};

/** 把一条消息的正文分成字、图片和文件。没有标记时只有字。 */
export function channelMessageParts(text: string): ChannelMessageParts {
  const lines: ChannelMessageLine[] = [];
  const images: ChannelImageRef[] = [];
  const files: ChannelFileRef[] = [];
  for (const line of text.split('\n')) {
    const marker = line.trim();
    const image = IMAGE_MARKER.exec(marker);
    if (image) {
      const ref = { fileId: image[2]!, name: image[1]!.trim(), marker };
      images.push(ref);
      lines.push({ kind: 'image', image: ref });
      continue;
    }
    const file = FILE_MARKER.exec(marker);
    if (file) {
      const head = file[1]!;
      const mime = MIME_SUFFIX.exec(head);
      const ref = {
        fileId: file[2]!,
        name: (mime ? head.slice(0, mime.index) : head).trim(),
        mimeType: mime ? mime[1]! : null,
        marker,
      };
      files.push(ref);
      lines.push({ kind: 'file', file: ref });
      continue;
    }
    lines.push({ kind: 'text', text: line });
  }
  return { lines, images, files };
}

/**
 * 卡上要写成文字的部分：普通的字，加上取不到的图片的原标记（放在原来的位置）。前后的空行去掉。
 * failed 里是取不到的图片的文件编号。
 */
export function channelMessageText(parts: ChannelMessageParts, failed: ReadonlySet<string> = new Set()): string {
  return parts.lines
    .flatMap((line) => {
      if (line.kind === 'text') return [line.text];
      if (line.kind === 'image' && failed.has(line.image.fileId)) return [line.image.marker];
      return [];
    })
    .join('\n')
    .trim();
}

