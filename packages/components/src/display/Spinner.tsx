import { useEffect } from 'react';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import type { ColorToken } from '../theme/tokens';
import { Icon } from './Icon';

export type SpinnerProps = {
  size?: number;
  color?: ColorToken;
  testID?: string;
};

// 持续旋转的进度图标，表示正在进行、时长未知。
export function Spinner({ size = 12, color = 'accent', testID }: SpinnerProps) {
  const rotation = useSharedValue(0);
  useEffect(() => {
    rotation.value = withRepeat(withTiming(360, { duration: 850, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(rotation);
  }, [rotation]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  return (
    <Animated.View testID={testID} role="progressbar" style={style}>
      <Icon name="progress" size={size} color={color} weight="bold" />
    </Animated.View>
  );
}
