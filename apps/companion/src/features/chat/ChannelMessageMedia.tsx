// 外来消息卡里一条消息的图片、文件和时间（工单 #529，视觉稿「Slack 消息卡：改前 / 改后」）。
//   · 图片：72 的方块缩略图（组件 ImageThumbnail 的 lg），跟着各自的消息，一条最多露 4 张，第 4 格盖「+N」；收起的卡上是 36 的小图。
//     点开是通用的 ImageViewer：左右切换，Esc 或点图外面的黑底关上，下面写「1 / 3」和「在 Slack 打开」。
//   · 图片按文件编号向 daemon 取（runtime.loadChannelImage）。取不到时这张图退回原来的文字标记，卡的其余部分照常。
//   · 不是图片的文件：「图标 + 文件名」的小标签，点了在 Slack 打开这条消息。
//   · 时间：浅灰小字，是这条消息在 Slack 里的链接，悬停时右边多一个外链图标。拿不到链接时只是字。
import {
  Box, IMAGE_THUMBNAIL_SIZES, Icon, ImageThumbnail, ImageViewer, Pressable, Row, Text, openURL, safeLink, spacingByDensity,
} from '@pi-lead-child/components';
import { useEffect, useRef, useState } from 'react';

import { useMessages } from '@/i18n';

import type { ChannelFileRef, ChannelImageRef } from './channelAttachments';
import { channelCardMessages } from './channelCard.messages';

export type ChannelImageLoader = (fileId: string) => Promise<{ mimeType: string; data: string }>;

// 一条消息最多露几张图，多的在最后一格写「+N」，点开能翻到全部。
export const CHANNEL_THUMBS_MAX = 4;

export type ChannelImageState = { uri: string | null; failed: boolean };

/**
 * 取一组图片：按文件编号给出地址（data: URI）。还在取时 uri 是 null；取不到或者没有 load 时 failed 是 true。
 * 换了一组图片时重新取（runtime 按编号缓存，取过的不再取）。
 */
export function useChannelImages(images: readonly ChannelImageRef[], load: ChannelImageLoader | undefined): ReadonlyMap<string, ChannelImageState> {
  const ids = images.map((image) => image.fileId).join(' ');
  const [loaded, setLoaded] = useState<ReadonlyMap<string, ChannelImageState>>(() => new Map());
  // 调用方每次重画可能给一个新的函数：只在图片换了时重新取，不因为函数换了再取。
  const loadRef = useRef(load);
  loadRef.current = load;
  const canLoad = Boolean(load);
  useEffect(() => {
    const read = loadRef.current;
    if (!ids || !read) return undefined;
    let live = true;
    const settle = (fileId: string, state: ChannelImageState) => {
      if (live) setLoaded((current) => new Map(current).set(fileId, state));
    };
    for (const fileId of new Set(ids.split(' '))) {
      read(fileId).then(
        (image) => settle(fileId, { uri: `data:${image.mimeType};base64,${image.data}`, failed: false }),
        () => settle(fileId, { uri: null, failed: true }),
      );
    }
    return () => { live = false; };
  }, [ids, canLoad]);
  const states = new Map<string, ChannelImageState>();
  for (const image of images) states.set(image.fileId, load ? loaded.get(image.fileId) ?? { uri: null, failed: false } : { uri: null, failed: true });
  return states;
}

/** 取不到的图片的文件编号。 */
export function failedImages(states: ReadonlyMap<string, ChannelImageState>): ReadonlySet<string> {
  return new Set([...states].filter(([, state]) => state.failed).map(([fileId]) => fileId));
}

// 一排放几张：按这一排的宽度算，间距按最宽的一档算（宁可少放一张，也不折成两行）。还没量到宽度（null 或 0）时按 max。
export function thumbsThatFit(width: number | null, size: 'sm' | 'lg', max: number): number {
  if (!width) return max;
  const gap = Math.max(...spacingByDensity.thumbnails);
  return Math.max(1, Math.min(max, Math.floor((width + gap) / (IMAGE_THUMBNAIL_SIZES[size] + gap))));
}

/**
 * 一排缩略图：取不到的不画（它们退回文字标记）。最多露 max 张，最后一格盖「+N」。点一张打开第几张。
 * 不折行：窄屏（手机）上放不下 max 张时少露几张，「+N」盖在这一排的最后一格。
 */
export function ChannelThumbs({ images, states, size, max = CHANNEL_THUMBS_MAX, onOpen, testID }: {
  images: readonly ChannelImageRef[];
  states: ReadonlyMap<string, ChannelImageState>;
  size: 'sm' | 'lg';
  max?: number;
  onOpen: (index: number) => void;
  testID: string;
}) {
  const m = useMessages(channelCardMessages).card;
  const [width, setWidth] = useState<number | null>(null);
  const shown = images.filter((image) => !states.get(image.fileId)?.failed);
  if (!shown.length) return null;
  const visible = shown.slice(0, thumbsThatFit(width, size, max));
  const hidden = shown.length - visible.length;
  return (
    <Row gap="thumbnails" testID={testID} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {visible.map((image, index) => (
        <ImageThumbnail
          key={image.fileId}
          testID={`${testID}-${index}`}
          size={size}
          uri={states.get(image.fileId)?.uri ?? null}
          label={m.openImage(image.name)}
          onPress={() => onOpen(index)}
          {...(hidden > 0 && index === visible.length - 1 ? { overlay: m.moreImages(hidden) } : {})}
        />
      ))}
    </Row>
  );
}

/** 不是图片的文件：「图标 + 文件名」的小标签。有链接时点了在 Slack 打开这条消息。 */
export function ChannelFileChip({ file, url, testID }: { file: ChannelFileRef; url: string | null; testID: string }) {
  const m = useMessages(channelCardMessages).card;
  const link = url ? safeLink(url) : null;
  const body = (
    <>
      <Icon name="file" size={14} color="accent-strong" />
      <Text size="secondary" weight="semibold" numberOfLines={1} shrink={1} minW={0}>{file.name}</Text>
      {link ? <Text size="meta" tone="secondary" shrink={0}>{`· ${m.openInSlack}`}</Text> : null}
    </>
  );
  const frame = {
    self: 'flex-start' as const, maxW: '100%' as const, items: 'center' as const, gap: 'icon-label' as const,
    bg: 'surface' as const, borderWidth: 1, borderColor: 'border' as const, rounded: 'lg' as const, px: 'inline-item' as const, py: 'text-stack' as const,
  };
  if (!link) return <Row {...frame} testID={testID}>{body}</Row>;
  return (
    <Pressable
      {...frame}
      flexDirection="row"
      testID={testID}
      role="link"
      aria-label={m.openFile(file.name)}
      onPress={() => openURL(link)}
    >
      {body}
    </Pressable>
  );
}

/** 一条消息的时间：浅灰小字。有链接时是链接，悬停时右边多一个外链图标；没有链接时只是字。 */
export function ChannelMessageTime({ at, url, testID }: { at: string; url: string | null; testID: string }) {
  const m = useMessages(channelCardMessages).card;
  const [hovered, setHovered] = useState(false);
  const link = url ? safeLink(url) : null;
  if (!link) return <Text size="meta" tone="muted" shrink={0} testID={testID}>{at}</Text>;
  return (
    <Pressable
      testID={testID}
      role="link"
      aria-label={m.openMessage(at)}
      flexDirection="row"
      items="center"
      gap="text-stack"
      shrink={0}
      feedback="none"
      // 悬停（桌面）：显示外链图标。Tamagui 在 web 上认这两个，类型里没有；手机上没有悬停，不会被调用。
      {...{ onHoverIn: () => setHovered(true), onHoverOut: () => setHovered(false) }}
      onPress={() => openURL(link)}
    >
      <Text size="meta" tone={hovered ? 'accent' : 'muted'}>{at}</Text>
      {/* 图标的位置一直占着：悬停时出现，时间不左右跳。 */}
      <Box w={10} opacity={hovered ? 1 : 0} aria-hidden testID={`${testID}-icon`}>
        <Icon name="arrow-up-right" size={10} color="accent" />
      </Box>
    </Pressable>
  );
}

/** 点开的图片：通用的 ImageViewer，点图外面的黑底关上，下面写「1 / 3」，有链接时有「在 Slack 打开」。 */
export function ChannelImagePreview({ preview, states, onClose, testID }: {
  preview: { images: readonly ChannelImageRef[]; index: number; url: string | null } | null;
  states: ReadonlyMap<string, ChannelImageState>;
  onClose: () => void;
  testID: string;
}) {
  const m = useMessages(channelCardMessages).card;
  if (!preview) return null;
  const link = preview.url ? safeLink(preview.url) : null;
  return (
    <ImageViewer
      testID={testID}
      open
      items={preview.images.map((image) => ({
        key: image.fileId,
        uri: states.get(image.fileId)?.uri ?? null,
        failed: states.get(image.fileId)?.failed ?? false,
        label: image.name,
        title: image.name,
      }))}
      initialIndex={preview.index}
      onClose={onClose}
      closeOnBackdrop
      counterPosition="bottom"
      {...(link ? { actions: [{ id: 'slack', label: m.openInSlack, icon: 'arrow-up-right' as const, onPress: () => openURL(link) }] } : {})}
    />
  );
}
