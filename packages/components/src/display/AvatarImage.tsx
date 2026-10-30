import { View } from '@tamagui/core';
import { Image } from 'react-native';

export type AvatarImageProps = {
  // 图片地址（data: URI）。还没取到时为 null：同样大小的空位，界面不跳。
  uri: string | null;
  size: number;
  // 无障碍名称（Lead 的名字，思考时加「在想」）。
  label: string;
  testID?: string;
};

// 一张代表 Lead 的图（主题 11.12 的 F-8、F-9）：在方框里完整显示，不裁成圆，不拉伸。动图照原样播放。
// 图本身不进无障碍树：外面的方框带名字。
export function AvatarImage({ uri, size, label, testID }: AvatarImageProps) {
  return (
    <View testID={testID} role="img" aria-label={label} w={size} h={size} shrink={0}>
      {uri ? (
        <Image
          testID={testID ? `${testID}-image` : undefined}
          source={{ uri }}
          resizeMode="contain"
          aria-hidden
          accessibilityIgnoresInvertColors
          style={{ width: size, height: size }}
        />
      ) : null}
    </View>
  );
}
