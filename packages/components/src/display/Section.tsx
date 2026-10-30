import type { ReactNode } from 'react';

import { Pressable } from '../primitives/Pressable';
import { Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { Icon } from './Icon';

export type SectionProps = {
  /** 不给时没有标题行，只有内容（例如执行卡片最上面的执行者和核查员两行）。 */
  title?: string;
  /** 标题旁的出处，例如「Lead 写的」「系统记录」「执行 agent 自述」。 */
  source?: string;
  /** 标题行右边的一句摘要。折叠后只剩标题行，摘要说明里面有什么。 */
  summary?: ReactNode;
  /** 摘要用等宽字，适合「4/5 · 15:18 更新」这类数字。 */
  summaryMono?: boolean;
  /** 是否折叠。组件不存这个状态：由调用方传入，点标题行时用 onToggle 告诉调用方。 */
  collapsed?: boolean;
  /** 给了它，标题行才能点，右边才有折叠箭头。参数是点了以后的折叠状态。 */
  onToggle?: (collapsed: boolean) => void;
  /**
   * card：白底细边框的卡片（任务说明、工单信息）。
   * subtle：浅灰底、没有边框（验收标准）。
   * group：一组卡片上面的大标题，没有外框（执行、交付与验收、经过与记录）。
   * part：卡片里的一段，上面一条分隔线（执行卡片里的用量、执行计划、运行记录）。
   */
  variant?: 'card' | 'subtle' | 'group' | 'part';
  /** 内容区四周留白。内容是贴边的列表行（RecordRow）时关掉。 */
  inset?: boolean;
  /** part：上面的分隔线。卡片里的第一段不画。 */
  divider?: boolean;
  children?: ReactNode;
  testID?: string;
};

const FRAME = {
  card: { bg: 'surface', borderWidth: 1, borderColor: 'border', rounded: 'xl', overflow: 'hidden' },
  subtle: { bg: 'surface-subtle', rounded: 'md', overflow: 'hidden' },
  group: {},
  part: { borderTopWidth: 1, borderTopColor: 'border-soft' },
} as const;

// 标题行的留白：卡片是 12/14，浅灰块是 10/12，大标题左右不留边（外面的页面排）。
// 折叠以后下面没有内容，标题行上下留白一样。
function headerPad(variant: NonNullable<SectionProps['variant']>, collapsed: boolean) {
  switch (variant) {
    case 'card':
    case 'part':
      return { px: 14, pt: 12, pb: collapsed ? 12 : 6 };
    case 'subtle':
      return { px: 12, pt: 10, pb: collapsed ? 10 : 6 };
    case 'group':
      return { pb: collapsed ? 0 : 10 };
  }
}

const BODY_PAD = {
  card: { px: 14, pb: 12 },
  subtle: { px: 12, pb: 6 },
  group: {},
  part: { px: 14, pb: 12 },
} as const;

// 一块有标题的内容：标题、出处、右边的摘要，可以折叠。
export function Section({
  title, source, summary, summaryMono = false, collapsed = false, onToggle, variant = 'card', inset = true, divider = true,
  children, testID,
}: SectionProps) {
  const frame = variant === 'part' && !divider ? {} : FRAME[variant];
  if (title === undefined) {
    // 没有标题行：内容上面留和标题行一样的白。
    const top = headerPad(variant, false).pt ?? 0;
    return (
      <Column testID={testID} {...frame}>
        <Column testID={testID ? `${testID}-body` : undefined} pt={inset ? top : 0} {...(inset ? BODY_PAD[variant] : {})}>{children}</Column>
      </Column>
    );
  }
  const pad = headerPad(variant, collapsed);
  const header = (
    <Row items="baseline" gap="inline-item" minW={0} {...(onToggle ? {} : pad)}>
      <Text size="section-title" leading={variant === 'group' ? 18 : 20} weight="extrabold" shrink={0}>{title}</Text>
      {source ? <Text size="meta" tone="secondary" shrink={0}>{source}</Text> : null}
      <Row ml="auto" items="baseline" gap="inline-item" shrink={1} minW={0}>
        {typeof summary === 'string' ? (
          <Text size="meta" mono={summaryMono} tone="secondary" numberOfLines={1} shrink={1} minW={0}>{summary}</Text>
        ) : summary}
        {onToggle ? (
          <Row self="center" shrink={0}>
            <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} color="text-secondary" weight="semibold" />
          </Row>
        ) : null}
      </Row>
    </Row>
  );
  return (
    <Column testID={testID} {...frame}>
      {onToggle ? (
        <Pressable
          testID={testID ? `${testID}-toggle` : undefined}
          aria-expanded={!collapsed}
          aria-label={`${title}，${collapsed ? '展开' : '折叠'}`}
          onPress={() => onToggle(!collapsed)}
          feedback="opacity"
          {...pad}
        >
          {header}
        </Pressable>
      ) : header}
      {collapsed ? null : (
        <Column testID={testID ? `${testID}-body` : undefined} {...(inset ? BODY_PAD[variant] : {})}>{children}</Column>
      )}
    </Column>
  );
}
