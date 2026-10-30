import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Modal, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { IconButton } from '../controls/Button';
import { useBreakpoint } from '../platform';
import { Pressable } from '../primitives/Pressable';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { palette } from '../theme/tokens';

export type PopoverProps = {
  /** 触发按钮给读屏的说法，例如「依据：系统通知，查看来源」。 */
  label: string;
  /** 触发按钮里的内容（文字、图标）。整块是一个按钮，有悬停和焦点样式。 */
  trigger: ReactNode;
  /** 浮层顶部的标题。 */
  title?: string;
  /** 浮层的内容。传函数时拿到 close：例如点了一行要跳转时，先关浮层。 */
  children: ReactNode | ((close: () => void) => ReactNode);
  /** 宽屏时浮层的宽度。 */
  width?: number;
  testID?: string;
};

type Anchor = { x: number; y: number; width: number; height: number };

const GAP = 6;
const EDGE = 8;
const MAX_HEIGHT = 420;

// 点开以后看详情的小浮层。宽屏时浮在触发按钮下面（下面放不下就放上面）；手机宽度时是从底部升起的面板。
// 点外面、按 Esc（web）或返回键（Android）关闭。用 React Native 的 Modal：web 上渲染到 body，不被滚动区裁掉。
export function Popover({ label, trigger, title, children, width = 360, testID }: PopoverProps) {
  const anchorRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const breakpoint = useBreakpoint();
  const sheet = !breakpoint.tablet;
  const open = anchor !== null;
  const close = useCallback(() => setAnchor(null), []);
  const show = useCallback(() => {
    const node = anchorRef.current as (View & { measureInWindow?: View['measureInWindow'] }) | null;
    if (node?.measureInWindow) {
      node.measureInWindow((x, y, measuredWidth, height) => setAnchor({ x, y, width: measuredWidth, height }));
    } else {
      setAnchor({ x: EDGE, y: EDGE, width: 0, height: 0 });
    }
  }, []);

  const panelWidth = Math.min(width, breakpoint.width - EDGE * 2);
  const below = anchor ? breakpoint.height - (anchor.y + anchor.height + GAP) - EDGE : 0;
  const above = anchor ? anchor.y - GAP - EDGE : 0;
  const placeBelow = below >= Math.min(MAX_HEIGHT, 240) || below >= above;
  const maxHeight = Math.max(160, Math.min(MAX_HEIGHT, placeBelow ? below : above));
  const left = anchor ? Math.max(EDGE, Math.min(anchor.x, breakpoint.width - panelWidth - EDGE)) : EDGE;
  const position = sheet || !anchor
    ? styles.sheet
    : placeBelow
      ? { position: 'absolute' as const, left, top: anchor.y + anchor.height + GAP, width: panelWidth }
      : { position: 'absolute' as const, left, bottom: breakpoint.height - anchor.y + GAP, width: panelWidth };

  return (
    <>
      <View ref={anchorRef} collapsable={false} style={styles.anchor}>
        <Pressable
          testID={testID}
          aria-label={label}
          aria-expanded={open}
          onPress={show}
          feedback="highlight"
          rounded="sm"
          // 键盘聚焦时一圈强调色的描边。
          outline={{ 'focus-visible': `2px solid ${palette.accent}` }}
        >
          {trigger}
        </Pressable>
      </View>
      {/* web 上不播动画：浮层点开就出现（react-native-web 的 Modal 要等动画结束事件才卸载）。 */}
      <Modal
        transparent
        visible={open}
        onRequestClose={close}
        animationType={Platform.OS === 'web' ? 'none' : sheet ? 'slide' : 'fade'}
      >
        <Pressable
          aria-label="关闭"
          feedback="none"
          cursor="default"
          onPress={close}
          style={[StyleSheet.absoluteFill, sheet ? styles.dim : null]}
        />
        <View style={position} pointerEvents="box-none">
          <Column
            testID={testID ? `${testID}-panel` : undefined}
            role="dialog"
            aria-label={title ?? label}
            bg="surface"
            borderWidth={1}
            borderColor="border"
            rounded="lg"
            {...(sheet ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : {})}
            boxShadow="0 12px 32px rgba(16,24,40,0.18)"
            overflow="hidden"
            maxH={sheet ? breakpoint.height * 0.7 : maxHeight}
          >
            <Row items="center" gap="inline-item" pl="card" pr="card" py="card" borderBottomWidth={1} borderBottomColor="border-soft">
              {sheet ? <Box position="absolute" t={5} l={0} r={0} items="center"><Box w={36} h={4} rounded="full" bg="border-strong" /></Box> : null}
              <Text flex={1} minW={0} size="section-title" weight="extrabold" numberOfLines={1} pt={sheet ? 6 : 0}>{title ?? label}</Text>
              <IconButton icon="close" label="关闭" onPress={close} size="sm" />
            </Row>
            <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
              {typeof children === 'function' ? children(close) : children}
            </ScrollView>
          </Column>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  anchor: { alignSelf: 'flex-start' },
  dim: { backgroundColor: 'rgba(16,24,40,0.32)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  body: { flexGrow: 0, flexShrink: 1, flexBasis: 'auto' },
  bodyContent: { padding: 12, gap: 8 },
});
