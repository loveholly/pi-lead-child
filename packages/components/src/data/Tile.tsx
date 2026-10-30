import { Icon } from '../display/Icon';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import type { ColorToken } from '../theme/tokens';
import { formatNumber } from './format';
import { dataToneFill, dataToneText, type DataTone } from './tones';

export type TileEmphasis = 'quiet' | 'normal' | 'strong';

export type TileProps = {
  /** 上面小标题条的文字，例如「10月」「登机口」。 */
  eyebrow?: string;
  /** 中间的大值：一个短值，例如 29、B12、87:84、v2.4。 */
  value: number | string;
  /** 下面一行说明，例如「周四 14:00」。放不下时截断。 */
  caption?: string;
  tone?: DataTone;
  size?: 'sm' | 'md';
  emphasis?: TileEmphasis;
  /**
   * 贴在卡片边上（Media 的 attach，视觉稿的「票根」）：没有自己的边框和圆角，竖向撑满整张卡，
   * 和正文之间由 Media 画打孔线。
   */
  attached?: boolean;
  /** 大值上面的一小行，例如星期（展开的日历页：「周五」）。 */
  above?: string;
  /** 最下面划掉的一行：改动前的值（例如「原 周四 29」）。 */
  was?: string;
  /** 大值用强调色：这是一个选了、还没提交的新值。 */
  highlight?: boolean;
  /** 小标题前一个勾：这件事已经完成（视觉稿：已确认的提醒，浅绿色带上一个勾）。 */
  done?: boolean;
  /** 大值上一道斜线、整块变灰：这件事取消了（视觉稿：已取消的提醒）。 */
  crossed?: boolean;
  testID?: string;
};

// 图块（genui v3 积木 1，2026-10-27）：上面一条浅色的小标题条，中间一个大的短值，下面一行说明。
// 清爽主题（docs/design/themes/default.md）：白底、1px 边框。色调只给小标题条（A-3，不铺满整块）：
// 普通的是浅色底、有色字；emphasis strong 时照视觉稿用实色底、白字，边框也换成这个色调（C-18 的例外，用户 2026-10-27 定）。
// 宽度只由 size 决定，不随 value 变：放进 Media 当前导时，正文的起点不跳。
const WIDTH = { sm: 64, md: 88 } as const;
const VALUE_SIZE = { sm: 'stat-value', md: 'tile-value' } as const;

// 勾的颜色跟着色带的字（success 是 success-dark）。
function dataToneFillText(tone: DataTone): ColorToken {
  return ({ neutral: 'text-secondary', info: 'accent-strong', success: 'success-dark', warning: 'warning-dark', danger: 'danger-dark' } as const)[tone];
}

const BAND: Record<DataTone, ColorToken> = {
  neutral: 'surface-muted', info: 'accent-soft', success: 'success-soft', warning: 'warning-soft', danger: 'danger-soft',
};
// strong 时图块的边框。
const STRONG_BORDER: Record<DataTone, ColorToken> = {
  neutral: 'border-strong', info: 'accent', success: 'success-border', warning: 'warning-border', danger: 'danger-border',
};

// 贴边时日历页整栏的底色（视觉稿 .stub 是 #F5F8FF）。
const ATTACHED_BG: Record<DataTone, ColorToken> = {
  // 视觉稿：发布的票根是浅绿（#F0FBF5，最接近的 token 是 success-soft）。
  neutral: 'surface-subtle', info: 'accent-wash', success: 'success-soft', warning: 'surface-subtle', danger: 'surface-subtle',
};
// 贴边时左边两个角跟着卡片的圆角（卡片 xl 是 12，减去 1px 边框）。组件规格。
const ATTACHED_RADIUS = 11;

export function Tile({
  eyebrow, value, caption, tone = 'neutral', size = 'md', emphasis = 'normal', attached = false, above, was, highlight = false,
  done = false, crossed = false, testID,
}: TileProps) {
  const text = typeof value === 'number' ? formatNumber(value) : value;
  // 强调等级只改颜色和字重，不改尺寸（v3 第 3 节）。
  const valueTone = crossed ? 'faint' : highlight ? 'accent' : emphasis === 'strong' ? dataToneText[tone] : emphasis === 'quiet' ? 'secondary' : 'default';
  const strong = emphasis === 'strong';
  const band: ColorToken = crossed ? 'surface-muted' : strong ? dataToneFill(tone) : emphasis === 'quiet' ? 'surface-muted' : BAND[tone];
  const bandText = strong ? 'inverse' : emphasis === 'quiet' ? 'secondary' : dataToneText[tone];
  return (
    <Column
      testID={testID}
      w={WIDTH[size]}
      shrink={0}
      {...(attached
        ? { flex: 1, borderTopLeftRadius: ATTACHED_RADIUS, borderBottomLeftRadius: ATTACHED_RADIUS }
        : { rounded: 'lg' as const, borderWidth: 1, borderColor: strong ? STRONG_BORDER[tone] : 'border' })}
      overflow="hidden"
      bg={attached ? ATTACHED_BG[tone] : 'surface'}
    >
      {eyebrow ? (
        // spacing-exempt: 图块小标题条的上下留白（组件规格）
        <Box testID={testID ? `${testID}-eyebrow` : undefined} bg={band} py={2} px="text-stack" items="center">
          <Row items="center" gap="text-stack">
            {done ? <Icon name="check" size={10} color={dataToneFillText(tone)} weight="bold" /> : null}
            <Text size="label" weight="semibold" tone={crossed ? 'muted' : bandText} numberOfLines={1}>{eyebrow}</Text>
          </Row>
        </Box>
      ) : null}
      {/* spacing-exempt: 图块正文的上下留白（组件规格） */}
      <Column flex={attached ? 1 : undefined} items="center" justify="center" py={size === 'sm' ? 4 : 6} px="text-stack" gap="text-stack">
        {above ? <Text size="label" weight="semibold" tone={highlight ? 'accent' : 'secondary'} numberOfLines={1}>{above}</Text> : null}
        {/* 视觉稿的大值是界面字体（不是等宽字体）：等宽的大号数字像代码。 */}
        <Box position="relative">
          <Text testID={testID ? `${testID}-value` : undefined} size={VALUE_SIZE[size]} weight="bold" tone={valueTone} numberOfLines={1}>
            {text}
          </Text>
          {crossed ? (
            // 一道斜线压在日期上（组件规格）。
            <Box testID={testID ? `${testID}-crossed` : undefined} position="absolute" l={-4} r={-4} t="50%" h={1.5} bg="text-faint" rotate="-24deg" pointerEvents="none" />
          ) : null}
        </Box>
        {caption ? <Text size="meta" mono={above !== undefined} tone={highlight ? 'accent' : 'secondary'} numberOfLines={1}>{caption}</Text> : null}
        {was ? <Text size="meta" tone="muted" textDecorationLine="line-through" numberOfLines={1}>{was}</Text> : null}
      </Column>
    </Column>
  );
}
