import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Modal,
  PanResponder,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useBreakpoint } from '../platform';
import { Pressable } from '../primitives/Pressable';
import { Text } from '../primitives/Text';
import { palette } from '../theme/tokens';
import { useMessages } from '../i18n';
import { displayMessages } from './display.messages';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { registerOverlay } from './overlayPresence';

export type ImageViewerItem = {
  key: string;
  // 图片地址（data: URI、本机文件或网址）。还没取到时为 null，显示加载中的空位。
  uri: string | null;
  // 无障碍名称，例如文件名或「图片 1」。
  label: string;
  // 取图失败：这一页显示提示图标。
  failed?: boolean;
  // 图下面的说明（可选）：title 是一行粗体，例如文件名；caption 是下面的小字，例如来源和「这是别人写的资料」。
  title?: string;
  caption?: string;
};

// 底部的操作，例如输入框里待发的图片有「删掉这张」。onPress 拿到的是当前这一张的序号。
export type ImageViewerAction = {
  id: string;
  label: string;
  icon: IconName;
  onPress: (index: number) => void;
};

export type ImageViewerProps = {
  open: boolean;
  items: readonly ImageViewerItem[];
  // 打开时显示第几张（从 0 开始）。
  initialIndex?: number;
  onClose: () => void;
  actions?: readonly ImageViewerAction[];
  testID?: string;
};

// 全屏看大图（2026-11-19 用户定：做成通用组件，不绑在某个场景上）。会话输入框里待发的图片、你发出的图片、工单附件都用它。
//   · 黑底铺满屏幕，图片按比例放下（不裁）。顶上左边是关闭，中间是「1 / 3」；下面是小圆点和调用方给的操作。
//   · 左右滑看上一张、下一张（web 上还有左右两颗按钮和方向键）。双指捏合放大到 4 倍，放大以后单指拖着看；
//     点两下在原大和 2.5 倍之间切换（web 上是双击）。
//   · 没放大时往下拖，松手时拖得够远或够快就关上，不够就弹回；按返回键（Android）或 Esc（web）也关上。
//   · 删到一张不剩时自己关上。每张图可以带一行标题和一段小字（例如工单附件的文件名和来源），写在图下面。
// 组件规格：按钮 44、按钮离边 16、圆点 6；底色用 black，按钮用 ink-raised，字和图标用 white。
const BUTTON = 44;
const EDGE = 16;
const DOT = 6;
const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 280;
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 0.8;
const SETTLE_MS = 200;
const MAX_DOTS = 10;
const easing = Easing.bezier(0.2, 0, 0, 1);

export function ImageViewer(props: ImageViewerProps) {
  const { open, items, onClose } = props;
  const empty = open && items.length === 0;
  // 删到一张不剩：关上。
  useEffect(() => { if (empty) onClose(); }, [empty, onClose]);
  if (!open || items.length === 0) return null;
  return <ImageViewerBody {...props} />;
}

function ImageViewerBody({ items, initialIndex = 0, onClose, actions = [], testID }: ImageViewerProps) {
  const m = useMessages(displayMessages);
  const insets = useSafeAreaInsets();
  const { width, height } = useBreakpoint();
  const [index, setIndex] = useState(() => clamp(initialIndex, 0, items.length - 1));
  const [zoomed, setZoomed] = useState(false);
  const scroller = useRef<ScrollView | null>(null);
  const dragY = useSharedValue(0);
  useEffect(() => registerOverlay(), []);

  // 删掉一张以后序号可能越界：停在最后一张。
  const last = items.length - 1;
  const current = clamp(index, 0, Math.max(0, last));
  useEffect(() => {
    if (index !== current) setIndex(current);
  }, [current, index]);

  const goTo = (next: number, animated = true) => {
    const target = clamp(next, 0, last);
    setIndex(target);
    scroller.current?.scrollTo({ x: target * width, y: 0, animated });
  };
  const goToRef = useRef(goTo);
  goToRef.current = goTo;

  // 打开时和屏幕变宽变窄时：滚到当前这一张。
  useEffect(() => {
    scroller.current?.scrollTo({ x: current * width, y: 0, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在宽度变了时重新对齐
  }, [width]);

  // web：方向键换图（Esc 由 Modal 的 onRequestClose 处理）。
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') goToRef.current(currentRef.current - 1);
      else if (event.key === 'ArrowRight') goToRef.current(currentRef.current + 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const currentRef = useRef(current);
  currentRef.current = current;

  const onScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(event.nativeEvent.contentOffset.x / Math.max(1, width));
    if (next !== current) setIndex(clamp(next, 0, last));
  };

  const backdropStyle = useAnimatedStyle(() => ({ opacity: 1 - Math.min(Math.abs(dragY.value) / 400, 0.6) }));
  const chromeStyle = useAnimatedStyle(() => ({ opacity: dragY.value === 0 ? 1 : 0 }));
  const many = items.length > 1;
  const item = items[current];

  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <View
        testID={testID}
        style={StyleSheet.absoluteFill}
        role="dialog"
        aria-modal
        aria-label={item ? m.imageOf(current + 1, items.length, item.label) : m.close}
        accessibilityViewIsModal
      >
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: palette.black }, backdropStyle]} />
        <ScrollView
          ref={scroller}
          horizontal
          pagingEnabled
          scrollEnabled={many && !zoomed}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onScrollEnd}
          onScrollEndDrag={Platform.OS === 'web' ? onScrollEnd : undefined}
          style={StyleSheet.absoluteFill}
          testID={testID ? `${testID}-pages` : undefined}
        >
          {items.map((page, pageIndex) => (
            <ZoomablePage
              key={page.key}
              item={page}
              width={width}
              height={height}
              active={pageIndex === current}
              dragY={dragY}
              failedLabel={m.imageFailed}
              onZoomChange={setZoomed}
              onDismiss={onClose}
              testID={testID ? `${testID}-page-${pageIndex}` : undefined}
            />
          ))}
        </ScrollView>

        <Animated.View pointerEvents="box-none" style={[styles.top, { top: insets.top + EDGE }, chromeStyle]}>
          <GlassButton testID={testID ? `${testID}-close` : undefined} icon="close" label={m.close} onPress={onClose} />
          {many ? (
            <View style={[styles.count, { backgroundColor: palette['ink-raised'] }]}>
              <Text size="label" weight="semibold" tone="inverse" testID={testID ? `${testID}-count` : undefined}>{`${current + 1} / ${items.length}`}</Text>
            </View>
          ) : null}
          <View style={styles.spacer} />
        </Animated.View>

        {Platform.OS === 'web' && many ? (
          <>
            {current > 0 ? (
              <View pointerEvents="box-none" style={[styles.side, { left: EDGE }]}>
                <GlassButton testID={testID ? `${testID}-previous` : undefined} icon="chevron-left" label={m.previousImage} onPress={() => goTo(current - 1)} />
              </View>
            ) : null}
            {current < last ? (
              <View pointerEvents="box-none" style={[styles.side, { right: EDGE }]}>
                <GlassButton testID={testID ? `${testID}-next` : undefined} icon="chevron-right" label={m.nextImage} onPress={() => goTo(current + 1)} />
              </View>
            ) : null}
          </>
        ) : null}

        <Animated.View pointerEvents="box-none" style={[styles.bottom, { bottom: insets.bottom + EDGE }, chromeStyle]}>
          {item?.title || item?.caption ? (
            <View style={[styles.caption, { backgroundColor: palette['ink-raised'] }]} testID={testID ? `${testID}-caption` : undefined}>
              {item.title ? <Text size="label" weight="semibold" tone="inverse" align="center">{item.title}</Text> : null}
              {item.caption ? <Text size="meta" align="center" style={{ color: palette['ink-subtle'] }}>{item.caption}</Text> : null}
            </View>
          ) : null}
          {many && items.length <= MAX_DOTS ? (
            <View style={styles.dots} aria-hidden>
              {items.map((page, pageIndex) => (
                <View key={page.key} style={[styles.dot, { backgroundColor: palette.white, opacity: pageIndex === current ? 1 : 0.4 }]} />
              ))}
            </View>
          ) : null}
          {actions.length ? (
            <View style={styles.actions}>
              {actions.map((action) => (
                <Pressable
                  key={action.id}
                  testID={testID ? `${testID}-action-${action.id}` : undefined}
                  aria-label={action.label}
                  onPress={() => action.onPress(current)}
                  feedback="none"
                  style={[styles.pill, { backgroundColor: palette['ink-raised'] }]}
                >
                  <Icon name={action.icon} size={18} color="white" />
                  <Text size="label" weight="semibold" tone="inverse">{action.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

function GlassButton({ icon, label, onPress, testID }: { icon: IconName; label: string; onPress: () => void; testID: string | undefined }) {
  return (
    <Pressable testID={testID} aria-label={label} onPress={onPress} feedback="none" style={[styles.round, { backgroundColor: palette['ink-raised'] }]}>
      <Icon name={icon} size={20} color="white" />
    </Pressable>
  );
}

// 一页：一张图，可以捏合放大、拖着看、点两下切换大小；没放大时往下拖关上。
function ZoomablePage({ item, width, height, active, dragY, failedLabel, onZoomChange, onDismiss, testID }: {
  item: ImageViewerItem;
  width: number;
  height: number;
  active: boolean;
  dragY: SharedValue<number>;
  failedLabel: string;
  onZoomChange: (zoomed: boolean) => void;
  onDismiss: () => void;
  testID: string | undefined;
}) {
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const gesture = useRef({ scale: 1, x: 0, y: 0, distance: 0, pinching: false, dismissing: false });
  const lastTap = useRef(0);
  const callbacks = useRef({ onZoomChange, onDismiss });
  callbacks.current = { onZoomChange, onDismiss };

  // 换到别的页时，这一页回到原大。
  useEffect(() => {
    if (active) return;
    scale.value = 1;
    x.value = 0;
    y.value = 0;
  }, [active, scale, x, y]);

  const setZoom = (next: number, focus?: { x: number; y: number }) => {
    const target = clamp(next, 1, MAX_SCALE);
    scale.value = withTiming(target, { duration: SETTLE_MS, easing });
    // 放大时把点的位置留在手指下面；回到原大时居中。
    const tx = focus && target > 1 ? (width / 2 - focus.x) * (target - 1) : 0;
    const ty = focus && target > 1 ? (height / 2 - focus.y) * (target - 1) : 0;
    x.value = withTiming(tx, { duration: SETTLE_MS, easing });
    y.value = withTiming(ty, { duration: SETTLE_MS, easing });
    callbacks.current.onZoomChange(target > 1);
  };
  const setZoomRef = useRef(setZoom);
  setZoomRef.current = setZoom;

  const pan = useMemo(() => {
    const distanceOf = (event: GestureResponderEvent) => {
      const [a, b] = event.nativeEvent.touches;
      return a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0;
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (event, state) => {
        if (event.nativeEvent.touches.length >= 2) return true;
        if (scale.value > 1) return true;
        // 竖着往下拖：关上。横着拖交给外面的翻页。
        return Math.abs(state.dy) > 8 && Math.abs(state.dy) > Math.abs(state.dx) * 1.5;
      },
      onPanResponderGrant: (event) => {
        gesture.current = { scale: scale.value, x: x.value, y: y.value, distance: distanceOf(event), pinching: event.nativeEvent.touches.length >= 2, dismissing: false };
      },
      onPanResponderMove: (event, state) => {
        const touches = event.nativeEvent.touches.length;
        const g = gesture.current;
        if (touches >= 2) {
          const distance = distanceOf(event);
          if (!g.pinching || g.distance === 0) {
            gesture.current = { ...g, scale: scale.value, distance, pinching: true };
            return;
          }
          scale.value = clamp(g.scale * (distance / g.distance), 1, MAX_SCALE);
          return;
        }
        if (g.pinching) return;
        if (g.scale > 1 || scale.value > 1) {
          x.value = g.x + state.dx;
          y.value = g.y + state.dy;
          return;
        }
        gesture.current.dismissing = true;
        dragY.value = state.dy;
        y.value = state.dy;
      },
      onPanResponderRelease: (_, state) => {
        const g = gesture.current;
        if (g.dismissing) {
          if (Math.abs(state.dy) > DISMISS_DISTANCE || Math.abs(state.vy) > DISMISS_VELOCITY) {
            callbacks.current.onDismiss();
            return;
          }
          dragY.value = withTiming(0, { duration: SETTLE_MS, easing });
          y.value = withTiming(0, { duration: SETTLE_MS, easing });
          return;
        }
        if (scale.value <= 1.05) {
          scale.value = withTiming(1, { duration: SETTLE_MS, easing });
          x.value = withTiming(0, { duration: SETTLE_MS, easing });
          y.value = withTiming(0, { duration: SETTLE_MS, easing }, () => runOnJS(callbacks.current.onZoomChange)(false));
          return;
        }
        // 拖出了边：拉回来，图片的边不离开屏幕的边。
        const limitX = (width * (scale.value - 1)) / 2;
        const limitY = (height * (scale.value - 1)) / 2;
        x.value = withTiming(clamp(x.value, -limitX, limitX), { duration: SETTLE_MS, easing });
        y.value = withTiming(clamp(y.value, -limitY, limitY), { duration: SETTLE_MS, easing });
        callbacks.current.onZoomChange(true);
      },
      onPanResponderTerminate: () => {
        dragY.value = withTiming(0, { duration: SETTLE_MS, easing });
        if (scale.value <= 1) y.value = withTiming(0, { duration: SETTLE_MS, easing });
      },
    });
  }, [dragY, height, scale, width, x, y]);

  const onTap = (event: { nativeEvent: { locationX: number; locationY: number } }) => {
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      const { locationX, locationY } = event.nativeEvent;
      setZoomRef.current(scale.value > 1 ? 1 : DOUBLE_TAP_SCALE, { x: locationX, y: locationY });
    } else {
      lastTap.current = now;
    }
  };

  // 小图不放大（放大发糊）：按比例放进屏幕，最大到原图的大小。还不知道尺寸时先占满。
  const [natural, setNatural] = useState<{ uri: string; width: number; height: number } | null>(null);
  useEffect(() => {
    const uri = item.uri;
    if (!uri) return undefined;
    let live = true;
    Image.getSize(uri, (w, h) => { if (live && w > 0 && h > 0) setNatural({ uri, width: w, height: h }); }, () => {});
    return () => { live = false; };
  }, [item.uri]);
  const known = natural && natural.uri === item.uri ? natural : null;
  const fit = known ? Math.min(width / known.width, height / known.height, 1) : 1;
  const box = known ? { width: Math.round(known.width * fit), height: Math.round(known.height * fit) } : { width, height };

  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  return (
    <View testID={testID} style={{ width, height }} {...pan.panHandlers}>
      <Pressable aria-label={item.label} feedback="none" cursor="zoom-in" onPress={onTap} style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.center, imageStyle]}>
          {item.uri ? (
            <Image source={{ uri: item.uri }} resizeMode="contain" accessibilityIgnoresInvertColors style={box} />
          ) : item.failed ? (
            <Icon name="error-outline" size={24} color="ink-muted" accessibilityLabel={failedLabel} />
          ) : null}
        </Animated.View>
      </Pressable>
    </View>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const styles = StyleSheet.create({
  top: { position: 'absolute', left: EDGE, right: EDGE, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  spacer: { width: BUTTON },
  side: { position: 'absolute', top: '50%', marginTop: -BUTTON / 2 },
  bottom: { position: 'absolute', left: EDGE, right: EDGE, alignItems: 'center', gap: EDGE },
  dots: { flexDirection: 'row', gap: DOT },
  // 「1 / 3」和图下的说明压在图上：浅色的截图铺满屏幕时白字看不清，所以和按钮一样垫一块 ink-raised 底（工单 #503）。
  count: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  caption: { alignItems: 'center', gap: 4, maxWidth: 560, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  actions: { flexDirection: 'row', gap: 12, justifyContent: 'center' },
  pill: { height: BUTTON, borderRadius: BUTTON / 2, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18 },
  round: { width: BUTTON, height: BUTTON, borderRadius: BUTTON / 2, alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
});
