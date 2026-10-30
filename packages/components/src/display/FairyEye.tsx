import { useEffect, useMemo } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import {
  FAIRY_BOX,
  FAIRY_CENTER,
  fairyDepth,
  fairyGeometry,
  fairyLayerScale,
  fairyMotion,
  fairyNextAngle,
  fairyPalettes,
  fairyTurnSpeed,
  type FairyEyeState,
  type FairyEyeTone,
} from './FairyEye.shared';

export type { FairyEyeState, FairyEyeTone } from './FairyEye.shared';

export type FairyEyeProps = {
  // 边长。左栏头部 32，消息头 18（主题 F-4、F-5）。
  size?: number;
  // idle：只转。thinking：转得快，中间的圈呼吸（M-7、M-8）。
  state?: FairyEyeState;
  // color 会动；muted、quiet 静止（F-1 到 F-3）。
  tone?: FairyEyeTone;
  // 无障碍标签。缺省是「Fairy」，思考时加「在想」。调用方传 Lead 的名字。
  name?: string;
  testID?: string;
};

// Fairy 的形象（P12.8，主题 11.12）：蓝色圆盘、会转的深色方块、四层眼睛、右下角的高光。
// 全部用 View 画，三端同一份；动效用 Reanimated，在 UI 线程上跑。几个 Fairy 共用页面时钟，所以一起呼吸。
// 规格（形状、颜色、节奏、出处）在 FairyEye.shared.ts。
export function FairyEye({ size = 18, state = 'idle', tone = 'color', name = 'Fairy', testID }: FairyEyeProps) {
  const reduced = useReducedMotion();
  const palette = fairyPalettes[tone];
  const moving = tone === 'color' && !reduced;
  const thinking = state === 'thinking' && tone === 'color';
  const depth = fairyDepth(size);

  const angle = useSharedValue(0);
  const clock = useSharedValue(0);
  const speed = useSharedValue(fairyTurnSpeed(state, moving));
  const amplitude = useSharedValue(thinking ? 1 : 0);

  // 状态切换：转速和呼吸幅度在 260 内过渡到新值（M-9）。减弱动态效果时直接到位（M-10）。
  useEffect(() => {
    const nextSpeed = fairyTurnSpeed(state, moving);
    const nextAmplitude = thinking ? 1 : 0;
    if (!moving) {
      speed.value = nextSpeed;
      amplitude.value = nextAmplitude;
      return;
    }
    speed.value = withTiming(nextSpeed, { duration: fairyMotion.switchMs });
    amplitude.value = withTiming(nextAmplitude, { duration: fairyMotion.switchMs });
  }, [amplitude, moving, speed, state, thinking]);

  // 每一帧推进方块的角度和呼吸的时钟。静止的 Fairy 不注册帧回调。
  const frame = useFrameCallback((info) => {
    'worklet';
    angle.value = fairyNextAngle(angle.value, speed.value, info.timeSincePreviousFrame ?? 0);
    clock.value = info.timestamp;
  }, false);
  useEffect(() => {
    frame.setActive(moving);
    return () => frame.setActive(false);
  }, [frame, moving]);

  // 减弱动态效果时，思考中的瞳孔停在缩小的位置；不思考时张开。
  const hold = moving ? undefined : (thinking ? fairyMotion.reducedHold : 0);
  const cornersStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${angle.value}deg` }],
  }), [angle]);
  const scleraStyle = useAnimatedStyle(() => ({
    transform: [{ scale: fairyLayerScale('sclera', clock.value, amplitude.value, depth, hold) }],
  }), [clock, amplitude, depth, hold]);
  const irisOuterStyle = useAnimatedStyle(() => ({
    transform: [{ scale: fairyLayerScale('irisOuter', clock.value, amplitude.value, depth, hold) }],
  }), [clock, amplitude, depth, hold]);
  // 高光和蓝色虹膜同一个相位（原图如此），画在瞳孔上面。
  const irisStyle = useAnimatedStyle(() => ({
    transform: [{ scale: fairyLayerScale('iris', clock.value, amplitude.value, depth, hold) }],
  }), [clock, amplitude, depth, hold]);
  const pupilStyle = useAnimatedStyle(() => ({
    transform: [{ scale: fairyLayerScale('pupil', clock.value, amplitude.value, depth, hold) }],
  }), [clock, amplitude, depth, hold]);

  const shapes = useMemo(() => fairyShapes(size), [size]);
  return (
    <View
      testID={testID}
      role="img"
      aria-label={thinking ? `${name} 在想` : name}
      pointerEvents="none"
      style={{ width: size, height: size, flexShrink: 0 }}
    >
      <View style={[shapes.disc, { backgroundColor: palette.disc }]} />
      <Animated.View style={[StyleSheet.absoluteFill, cornersStyle]}>
        <View style={[shapes.cornersCircle, { backgroundColor: palette.corners }]} />
        <View style={[shapes.cornersSquare, { backgroundColor: palette.corners }]} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, scleraStyle]}>
        <View style={[shapes.sclera, { backgroundColor: palette.sclera }]} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, irisOuterStyle]}>
        <View style={[shapes.irisOuter, { backgroundColor: palette.irisOuter }]} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, irisStyle]}>
        <View style={[shapes.irisRing, { backgroundColor: palette.sclera }]} />
        <View style={[shapes.iris, { backgroundColor: palette.iris }]} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, pupilStyle]}>
        <View style={[shapes.pupil, { backgroundColor: palette.pupil }]} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, irisStyle]}>
        <View style={[shapes.highlightHalo, { backgroundColor: palette.highlight, opacity: 0.35 }]} />
        <View style={[shapes.highlight, { backgroundColor: palette.highlight }]} />
      </Animated.View>
    </View>
  );
}

// 一个圆：直径和圆心（盒子的单位）换成像素。
function circle(size: number, diameter: number, dx = 0, dy = 0): ViewStyle {
  const unit = size / FAIRY_BOX;
  const d = diameter * unit;
  return {
    position: 'absolute',
    width: d,
    height: d,
    borderRadius: d / 2,
    left: (FAIRY_CENTER + dx) * unit - d / 2,
    top: (FAIRY_CENTER + dy) * unit - d / 2,
  };
}

function fairyShapes(size: number) {
  const g = fairyGeometry;
  const unit = size / FAIRY_BOX;
  const side = g.cornersSquare * unit;
  return {
    disc: circle(size, g.disc),
    cornersCircle: circle(size, g.cornersCircle),
    cornersSquare: {
      position: 'absolute',
      width: side,
      height: side,
      borderRadius: 2 * unit,
      left: FAIRY_CENTER * unit - side / 2,
      top: FAIRY_CENTER * unit - side / 2,
      transform: [{ rotate: `${g.cornersSquareTilt}deg` }],
    } satisfies ViewStyle,
    sclera: circle(size, g.sclera),
    irisOuter: circle(size, g.irisOuter),
    irisRing: circle(size, g.irisRing),
    iris: circle(size, g.iris),
    pupil: circle(size, g.pupil),
    highlightHalo: circle(size, g.highlightHalo, g.highlightOffset.x, g.highlightOffset.y),
    highlight: circle(size, g.highlight, g.highlightOffset.x, g.highlightOffset.y),
  };
}
