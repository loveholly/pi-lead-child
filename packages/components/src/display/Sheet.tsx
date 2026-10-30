import { useEffect, type ReactNode } from 'react';
import { BackHandler, Platform, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { Easing, FadeIn, FadeOut, ReduceMotion, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton } from '../controls/Button';
import { Pressable } from '../primitives/Pressable';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { zIndex } from '../theme/tokens';

export type SheetProps = {
  /** 是否打开。组件不存这个状态。 */
  open: boolean;
  /** 点遮罩、关闭按钮，按 Esc（web）或返回键（Android）时调用。 */
  onClose: () => void;
  title: string;
  /** 标题下面的一句说明，例如「Claude Code · 现在是 sonnet · 推理强度 high」。 */
  subtitle?: string;
  /** 关闭按钮的无障碍名称，例如「关闭，不换」。 */
  closeLabel?: string;
  children?: ReactNode;
  /** 面板底部，例如取消和应用按钮。不随内容滚动。 */
  footer?: ReactNode;
  testID?: string;
};

const easing = Easing.bezier(0.2, 0, 0, 1);
const scrimIn = FadeIn.duration(200).reduceMotion(ReduceMotion.System);
const scrimOut = FadeOut.duration(160).reduceMotion(ReduceMotion.System);
const panelIn = SlideInDown.duration(260).easing(easing).reduceMotion(ReduceMotion.System);
const panelOut = SlideOutDown.duration(200).easing(easing).reduceMotion(ReduceMotion.System);

// 从底部升起的面板（第四轮画板的换模型和强度）。盖住最近的父容器：桌面上是工单详情的侧滑栏，手机上是整屏。
// 父容器要能给它定位（React Native 的 View 默认就是）。关着时只留一个不挡点按的空层，
// 面板和遮罩卸载时还能播退出动画。
export function Sheet({ open, onClose, title, subtitle, closeLabel = '关闭', children, footer, testID }: SheetProps) {
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);
  // 返回键只有 Android 有。react-native-web 的 BackHandler 一调用就报错，所以只在 Android 上监听。
  useEffect(() => {
    if (!open || Platform.OS !== 'android') return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [open, onClose]);
  return (
    <View style={styles.layer} pointerEvents="box-none">
      {open ? (
        <Animated.View entering={scrimIn} exiting={scrimOut} style={StyleSheet.absoluteFill}>
          <Pressable
            testID={testID ? `${testID}-scrim` : undefined}
            aria-label={closeLabel}
            feedback="none"
            cursor="default"
            onPress={onClose}
            position="absolute"
            t={0}
            r={0}
            b={0}
            l={0}
            bg="text"
            opacity={0.36}
          />
        </Animated.View>
      ) : null}
      {open ? (
        <Animated.View entering={panelIn} exiting={panelOut} style={styles.panel}>
          <Column
            testID={testID}
            role="dialog"
            aria-modal
            aria-label={title}
            shrink={1}
            minH={0}
            bg="surface"
            borderTopLeftRadius={16}
            borderTopRightRadius={16}
            boxShadow="0 -12px 32px rgba(16,24,40,0.18)"
            overflow="hidden"
            pb={insets.bottom}
          >
            {/* spacing-exempt: 拖动把手上方留白 */}
            <Box self="center" mt={7} w={38} h={5} rounded="full" bg="border-strong" />
            {/* spacing-exempt: 面板标题栏的规格 */}
            <Row items="flex-start" gap="inline-item" px={20} pt={10}>
              <Column flex={1} minW={0}>
                <Text size="section-title" weight="extrabold">{title}</Text>
                {subtitle ? <Text mt="text-stack" size="secondary" tone="strong">{subtitle}</Text> : null}
              </Column>
              <IconButton
                icon="close"
                label={closeLabel}
                onPress={onClose}
                variant="soft"
                size="xs"
                rounded="sm"
                iconColor="text-secondary"
                testID={testID ? `${testID}-close` : undefined}
              />
            </Row>
            <ScrollView testID={testID ? `${testID}-body` : undefined} style={styles.body} contentContainerStyle={styles.bodyContent}>
              {children}
            </ScrollView>
            {/* spacing-exempt: 面板底栏的规格 */}
            {footer ? <Box px={20} pt={16} pb={16}>{footer}</Box> : null}
          </Column>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { ...StyleSheet.absoluteFill, zIndex: zIndex.modal },
  // 面板最高到父容器的九成，内容更多时在面板里滚动。
  panel: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '90%' },
  // 内容区不能写 flex: 0（react-native-web 会把它展开成 0 基准，内容塌掉）：按内容高度，放不下时收缩。
  body: { flexGrow: 0, flexShrink: 1, flexBasis: 'auto' },
  bodyContent: { paddingHorizontal: 20, paddingTop: 16 },
});
