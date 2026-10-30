import type { ReactNode } from 'react';

import { Box, Column, Row } from '../primitives/layout';

export type MediaRowProps = {
  /** 左边固定宽的前导，例如一个 Tile。宽度由前导自己决定。 */
  lead: ReactNode;
  /** 右边撑满剩下宽度的正文。 */
  children: ReactNode;
  /** 前导和正文之间画一条打孔线，像一张票根。 */
  attach?: boolean;
  align?: 'start' | 'center';
  /**
   * 这一行就是整张卡（卡片不留内边距）：前导贴住卡片的上、下、左三边，正文自己留卡片的内边距。
   * 视觉稿的提醒卡就是这样：日历页是卡片的左边一栏。
   */
  bleed?: boolean;
  /**
   * bleed 时打孔线两头的半圆缺口，缺省画。浮层里不画：缺口伸出浮层的边，浏览器在焦点移进去时会把浮层滚动这几个像素
   * （2026-10-27：选了一个时间以后，日历页的月份被顶出浮层 6 px）。
   */
  notches?: boolean;
  testID?: string;
};

// 前导 + 正文（媒体对象，genui v3 积木 2，2026-10-27）。正文的起点只由前导的宽度决定，不由正文决定。
// 清爽主题：attach 时中间是一条 1.5px 的 border-strong 虚线（R-6，打孔线），用短线段画。
export function MediaRow({ lead, children, attach = false, align = 'start', bleed = false, notches = true, testID }: MediaRowProps) {
  if (bleed) {
    return (
      <Row testID={testID} items="stretch">
        <Box shrink={0}>{lead}</Box>
        {attach ? <Perforation testID={testID} notches={notches} /> : null}
        <Column flex={1} minW={0} justify={align === 'center' ? 'center' : 'flex-start'} p="card">{children}</Column>
      </Row>
    );
  }
  return (
    <Row testID={testID} gap="side-item" items={align === 'center' ? 'center' : 'flex-start'}>
      <Box shrink={0}>{lead}</Box>
      {attach ? <Perforation testID={testID} /> : null}
      <Column flex={1} minW={0}>{children}</Column>
    </Row>
  );
}

// 打孔线用一列短线段画：0 宽的盒子画 1.5px 的虚线边框，浏览器画成了斜纹锯齿（2026-10-27 截图）。
// 线段的长度和间距是组件规格。行有多高事先不知道，所以多画一些，超出的裁掉。
const DASHES = 40;

function Perforation({ testID, notches = false }: { testID?: string; notches?: boolean }) {
  // 线段绝对定位，不参与排版：行的高度只由前导和正文决定（2026-10-27：线段列曾经把卡片撑高到 280）。
  // notches：整张卡是票根时，打孔线两头在卡片的上下边上各咬一个半圆缺口（视觉稿 .notch：10px 圆、白底、1px 边框，
  // 圆心在卡片的边线上）。卡片这时不裁掉边外的内容（SurfaceView 的 bleed）。
  return (
    <Box testID={testID ? `${testID}-perforation` : undefined} self="stretch" w={1.5} position="relative" pointerEvents="none">
      <Box position="absolute" t={0} b={0} l={0} w={1.5} overflow="hidden">
        <Column gap={3}>{/* spacing-exempt: 打孔线的线段间距（组件规格，R-6） */}
          {Array.from({ length: DASHES }, (_, index) => <Box key={index} h={4} w={1.5} bg="border-strong" />)}
        </Column>
      </Box>
      {notches ? (
        <>
          <Notch testID={testID ? `${testID}-notch-top` : undefined} edge="top" />
          <Notch testID={testID ? `${testID}-notch-bottom` : undefined} edge="bottom" />
        </>
      ) : null}
    </Box>
  );
}

// 半圆缺口：一个 12px（含 1px 边框）的白圆，圆心压在卡片的边线上（卡片边框 1px，所以离行的边是 -7）。组件规格。
const NOTCH = 12;
function Notch({ edge, testID }: { edge: 'top' | 'bottom'; testID?: string }) {
  return (
    <Box
      testID={testID}
      position="absolute"
      {...(edge === 'top' ? { t: -(NOTCH / 2 + 1) } : { b: -(NOTCH / 2 + 1) })}
      l={0.75 - NOTCH / 2}
      w={NOTCH}
      h={NOTCH}
      rounded="full"
      bg="surface"
      borderWidth={1}
      borderColor="border"
    />
  );
}
