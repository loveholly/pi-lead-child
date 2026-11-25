import { View } from '@tamagui/core';
import { Image } from 'react-native';

import { Pressable } from '../primitives/Pressable';
import { Text } from '../primitives/Text';
import { Icon } from './Icon';
import { useMessages } from '../i18n';
import { displayMessages } from './display.messages';

// 图片小图的规格：64×64 的圆角盒子，图片铺满、裁掉多出来的部分（Claude Code 输入框里待发图片的样式）。
// 删除按钮是右上角一个 20 像素的深色圆，离边 4 像素：图片什么颜色都看得见，手机上不用悬停也点得到。
// 三档大小（组件规格）：md 64 是缺省；lg 72 是外来消息卡里的图，sm 36 是卡片收起时的小图（工单 #529）。
export const IMAGE_THUMBNAIL_SIZES = { sm: 36, md: 64, lg: 72 } as const;
const SIZES = IMAGE_THUMBNAIL_SIZES;
// 盖在最后一格上的「+N」（还有几张没露出来）：text 色 55% 不透明的底，白字。
const OVERLAY_BG = 'rgba(16,19,26,0.55)';
const REMOVE_SIZE = 20;
const REMOVE_INSET = 4;
// 删除按钮的底色：text 色 64% 不透明，压在任何图片上都看得清白色的叉。
const REMOVE_BG = 'rgba(16,19,26,0.64)';

export type ImageThumbnailProps = {
  // 图片地址（data: URI 或本机文件）。还没取到时为 null，显示浅灰的占位块。
  uri: string | null;
  // 无障碍名称，例如「图片 1」。
  label: string;
  // 取图失败：占位块里显示一个提示图标。
  failed?: boolean;
  // 给出时整张小图可以点，例如点开看大图（工单附件）。无障碍名称用 label。
  onPress?: () => void;
  // 给出时右上角有删除按钮。
  onRemove?: () => void;
  removeLabel?: string;
  // 大小，缺省 md（64）。
  size?: keyof typeof SIZES;
  // 盖在图上的一行字，例如「+2」：一排只露几张时，最后一格写还有几张。
  overlay?: string;
  testID?: string;
};

// 一张图片的小图：会话输入框上方待发的图片，会话里你发过的图片，工单详情里的附件。
export function ImageThumbnail({
  uri, label, failed = false, onPress, onRemove, removeLabel: removeLabelProp, size = 'md', overlay, testID,
}: ImageThumbnailProps) {
  const m = useMessages(displayMessages);
  const removeLabel = removeLabelProp ?? m.removeImage;
  const side = SIZES[size];
  return (
    <View
      testID={testID}
      role="img"
      aria-label={label}
      position="relative"
      w={side}
      h={side}
      shrink={0}
      rounded={size === 'sm' ? 'lg' : 'xl'}
      overflow="hidden"
      bg="surface-muted"
      borderWidth={1}
      borderColor="border-soft"
    >
      {uri ? (
        <Image source={{ uri }} resizeMode="cover" accessibilityIgnoresInvertColors style={{ width: side, height: side }} />
      ) : failed ? (
        <View flex={1} items="center" justify="center">
          <Icon name="error-outline" size={size === 'sm' ? 14 : 18} color="text-muted" accessibilityLabel={m.imageFailed} />
        </View>
      ) : null}
      {overlay ? (
        <View position="absolute" t={0} r={0} b={0} l={0} items="center" justify="center" style={{ backgroundColor: OVERLAY_BG }}>
          <Text size="card-title" weight="semibold" tone="inverse">{overlay}</Text>
        </View>
      ) : null}
      {onPress ? (
        <Pressable
          testID={testID ? `${testID}-open` : undefined}
          aria-label={label}
          onPress={onPress}
          position="absolute"
          t={0}
          r={0}
          b={0}
          l={0}
        />
      ) : null}
      {onRemove ? (
        <Pressable
          testID={testID ? `${testID}-remove` : undefined}
          aria-label={removeLabel}
          onPress={onRemove}
          position="absolute"
          t={REMOVE_INSET}
          r={REMOVE_INSET}
          w={REMOVE_SIZE}
          h={REMOVE_SIZE}
          rounded="full"
          items="center"
          justify="center"
          style={{ backgroundColor: REMOVE_BG }}
        >
          <Icon name="close" size={12} color="surface" weight="bold" />
        </Pressable>
      ) : null}
    </View>
  );
}
