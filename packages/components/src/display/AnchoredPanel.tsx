import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { useBreakpoint } from '../platform';
import { Pressable } from '../primitives/Pressable';
import { Box, Column } from '../primitives/layout';

export type AnchoredPanelProps = {
  /** 收着时在页面里的内容（例如一张一行的卡片）。浮层打开时它留在原位，高度不变。 */
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  /** 浮层最上面的一行。它压在 children 原来的位置上：看起来是那一行变成了浮层的头。 */
  header: ReactNode;
  /** 浮层的正文。太长时在浮层里滚动，滚到头不带着页面一起滚。没有时浮层只有头（头里就是全部内容）。 */
  body?: ReactNode;
  /** 给读屏的浮层名字，例如「#77 的进展」。 */
  label: string;
  maxHeight?: number;
  testID?: string;
};

type Anchor = { x: number; y: number; width: number; height: number };

const EDGE = 8;
const DEFAULT_MAX_HEIGHT = 440;

// 从页面里一块内容原来的位置打开的浮层（2026-10-17，会话方案第五版的合一工单卡）。
//   · 宽屏时和那块内容一样宽、左边对齐；下面放得下就往下开，头压在原位；放不下就往上开，头留在最下面，还是压在原位；
//   · 手机宽度时是从底部升起的面板；
//   · 点外面、按 Esc（web）或返回键（Android）关闭；
//   · 用 React Native 的 Modal：web 上渲染到 body，不被滚动区裁掉，页面也不因为它变高、跳动。
export function AnchoredPanel({ children, open, onClose, header, body, label, maxHeight = DEFAULT_MAX_HEIGHT, testID }: AnchoredPanelProps) {
  const anchorRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const breakpoint = useBreakpoint();
  const sheet = !breakpoint.tablet;

  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const node = anchorRef.current as (View & { measureInWindow?: View['measureInWindow'] }) | null;
    if (node?.measureInWindow) {
      node.measureInWindow((x, y, width, height) => setAnchor({ x, y, width, height }));
    } else {
      setAnchor({ x: EDGE, y: EDGE, width: breakpoint.width - EDGE * 2, height: 0 });
    }
  }, [breakpoint.width, open]);

  const below = anchor ? breakpoint.height - anchor.y - EDGE : 0;
  const above = anchor ? anchor.y + anchor.height - EDGE : 0;
  // 下面放不下一个最高的浮层、而上面空间更大时往上开（卡片在会话下半部分时，不去压输入框）。
  const upward = !sheet && anchor !== null && below < maxHeight && above > below;
  const height = sheet ? breakpoint.height * 0.75 : Math.max(160, Math.min(maxHeight, upward ? above : below));
  const position = sheet || !anchor
    ? styles.sheet
    : upward
      ? { position: 'absolute' as const, left: anchor.x, width: anchor.width, bottom: breakpoint.height - anchor.y - anchor.height }
      : { position: 'absolute' as const, left: anchor.x, width: anchor.width, top: anchor.y };

  return (
    <View ref={anchorRef} collapsable={false} style={styles.anchor} testID={testID}>
      {children}
      {/* web 上 Modal 不播动画（react-native-web 要等动画结束事件才卸载），浮层自己滑进来。 */}
      <Modal
        transparent
        visible={open && anchor !== null}
        onRequestClose={onClose}
        animationType={Platform.OS === 'web' ? 'none' : sheet ? 'slide' : 'fade'}
      >
        {/* 手机上是底部面板，后面压暗一层（和「依据」浮层一样）；宽屏时不压暗，浮层就是那张卡片变出来的。 */}
        <Pressable aria-label="收起" feedback="none" cursor="default" onPress={onClose} style={[StyleSheet.absoluteFill, sheet ? styles.dim : null]} />
        <View style={position} pointerEvents="box-none">
          <PanelFrame testID={testID ? `${testID}-panel` : undefined} label={label} sheet={sheet} upward={upward} maxHeight={height}>
            {/* 只有头的浮层：头放进能滚动的区域里，打开时焦点落在它上面，不落在头里第一个按钮上（不会画一圈焦点框）。 */}
            {body === undefined ? <ScrollView style={styles.body}>{header}</ScrollView> : <Box shrink={0}>{header}</Box>}
            {body !== undefined ? (
              <>
                {/* spacing-exempt: 分隔线内缩同面板内边距 */}
                <Box h={1} mx={16} bg="border-soft" shrink={0} />
                <ScrollView style={styles.body}>{body}</ScrollView>
              </>
            ) : null}
          </PanelFrame>
        </View>
      </Modal>
    </View>
  );
}

// 浮层的外框。打开以后下一帧从 6 px 外滑进来、淡入（web 上是 CSS transition）。
function PanelFrame({ testID, label, sheet, upward, maxHeight, children }: {
  testID?: string;
  label: string;
  sheet: boolean;
  upward: boolean;
  maxHeight: number;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(Platform.OS !== 'web');
  useEffect(() => {
    if (shown) return undefined;
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [shown]);
  return (
    <Column
      testID={testID}
      role="dialog"
      aria-label={label}
      // 打开时 Modal 把焦点交给第一个能聚焦的元素。浮层自己能聚焦（-1：不进 Tab 顺序），焦点就落在对话框上，
      // 不会落在正文里的按钮或能横向滚动的表格上、被画一圈焦点框。
      tabIndex={-1}
      outlineStyle="none"
      bg="surface"
      borderWidth={1}
      borderColor="border"
      rounded="xl"
      {...(sheet ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : {})}
      boxShadow="0 16px 40px rgba(16,19,26,0.14), 0 2px 6px rgba(16,19,26,0.06)"
      overflow="hidden"
      maxH={maxHeight}
      flexDirection={upward ? 'column-reverse' : 'column'}
      opacity={shown ? 1 : 0}
      y={shown ? 0 : upward ? 6 : -6}
      transition="quick"
    >
      {children}
    </Column>
  );
}

const styles = StyleSheet.create({
  anchor: { width: '100%' },
  dim: { backgroundColor: 'rgba(16,24,40,0.32)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  // 浮层打开时 Modal 把焦点交给能滚动的正文，Chrome 会给它画一圈焦点框。浮层自己有边框和阴影，不需要这一圈。
  body: { flexGrow: 0, flexShrink: 1, flexBasis: 'auto', outlineWidth: 0 },
});
