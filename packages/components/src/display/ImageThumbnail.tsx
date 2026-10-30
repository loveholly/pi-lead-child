import { View } from '@tamagui/core';
import { Image } from 'react-native';

import { Pressable } from '../primitives/Pressable';
import { Icon } from './Icon';

// 图片小图的规格：64×64 的圆角盒子，图片铺满、裁掉多出来的部分（Claude Code 输入框里待发图片的样式）。
// 删除按钮是右上角一个 20 像素的深色圆，离边 4 像素：图片什么颜色都看得见，手机上不用悬停也点得到。
const SIZE = 64;
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
  // 给出时右上角有删除按钮。
  onRemove?: () => void;
  removeLabel?: string;
  testID?: string;
};

// 一张图片的小图：会话输入框上方待发的图片，会话里你发过的图片。
export function ImageThumbnail({ uri, label, failed = false, onRemove, removeLabel = '移除图片', testID }: ImageThumbnailProps) {
  return (
    <View
      testID={testID}
      role="img"
      aria-label={label}
      position="relative"
      w={SIZE}
      h={SIZE}
      shrink={0}
      rounded="xl"
      overflow="hidden"
      bg="surface-muted"
      borderWidth={1}
      borderColor="border-soft"
    >
      {uri ? (
        <Image source={{ uri }} resizeMode="cover" accessibilityIgnoresInvertColors style={{ width: SIZE, height: SIZE }} />
      ) : failed ? (
        <View flex={1} items="center" justify="center">
          <Icon name="error-outline" size={18} color="text-muted" accessibilityLabel="图片加载失败" />
        </View>
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
