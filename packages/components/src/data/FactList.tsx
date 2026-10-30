import type { ReactNode } from 'react';

import { Button } from '../controls/Button';
import { Badge, type BadgeTone } from '../display/Badge';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';

// 一行旁边的小链接，例如「设置」「换核查员」。inline 紧跟在内容后面，end 靠这一行的右边。
// disabled：现在不能做，链接画成不能点（原因由调用方写在这一行的 detail 里）。
export type FactAction = { label: string; onPress: () => void; align?: 'inline' | 'end'; disabled?: boolean; testID?: string };

export type FactItem = {
  /** tagged：内容前面的等宽小标签，例如 F1，可以不给。labeled：左边一列的名字。 */
  label?: string;
  value: ReactNode;
  /** 内容用等宽字，例如分支名、提交号。 */
  mono?: boolean;
  /** 内容下面的一句补充（labeled）。 */
  detail?: string;
  /** 这一行右边的状态标签。 */
  badge?: { label: string; tone?: BadgeTone };
  action?: FactAction;
};

export type FactListProps = {
  items: readonly FactItem[];
  /**
   * tagged：聊天卡片里的事实列表，每条一行，前面可以有一个等宽小标签，后面可以有状态标签。
   * labeled：工单信息这类名字和值的对照（第四轮画板），左边一列名字，右边是值。
   */
  variant?: 'tagged' | 'labeled';
  /** labeled 时左边名字一列的宽度。 */
  labelWidth?: number;
  testID?: string;
};

// 几条事实，一条一行。
export function FactList({ items, variant = 'tagged', labelWidth = 72, testID }: FactListProps) {
  if (variant === 'labeled') {
    return (
      <Column testID={testID}>
        {items.map((item, index) => <LabeledFact key={index} item={item} labelWidth={labelWidth} />)}
      </Column>
    );
  }
  return (
    <Column testID={testID} gap="stacked-card">
      {items.map((item, index) => (
        <Row key={index} items="flex-start" gap="inline-item">
          {item.label ? (
            <Box px="pill-x" rounded="sm" bg="surface-muted" shrink={0}>
              {/* spacing-exempt: 标签字号行高 */}
              <Text size="12" mono weight="semibold" leading={20}>{item.label}</Text>
            </Box>
          ) : null}
          {typeof item.value === 'string' ? (
            <Text flex={1} minW={0} size="body" mono={item.mono}>{item.value}</Text>
          ) : (
            <Box flex={1} minW={0}>{item.value}</Box>
          )}
          {item.badge ? <Badge label={item.badge.label} tone={item.badge.tone} /> : null}
        </Row>
      ))}
    </Column>
  );
}

function LabeledFact({ item, labelWidth }: { item: FactItem; labelWidth: number }) {
  const action = item.action ? <FactLink action={item.action} /> : null;
  const end = item.action?.align === 'end';
  return (
    // spacing-exempt: 标签列与值列的间距
    <Row items="baseline" gap={12} py="row-y">
      <Text w={labelWidth} shrink={0} size="label" weight="bold" tone="secondary">{item.label ?? ''}</Text>
      <Column flex={1} minW={0}>
        <Row items="baseline" gap="inline-item" flexWrap={end ? 'nowrap' : 'wrap'}>
          {typeof item.value === 'string' ? (
            // spacing-exempt: 行高对齐正文
            <Text shrink={1} minW={0} size={item.mono ? '11.5' : '12.5'} leading={20} mono={item.mono}>{item.value}</Text>
          ) : (
            <Box shrink={1} minW={0}>{item.value}</Box>
          )}
          {item.badge ? <Badge label={item.badge.label} tone={item.badge.tone} size="xs" /> : null}
          {end ? <Box ml="auto" shrink={0}>{action}</Box> : action}
        </Row>
        {item.detail ? <Text size="secondary" tone="strong">{item.detail}</Text> : null}
      </Column>
    </Row>
  );
}

// 行内的文字链接按钮。按钮有 28 高，上下各收回 4，这一行仍是正文的 20 高。
function FactLink({ action }: { action: FactAction }) {
  return (
    // spacing-exempt: 负边距保持行高
    <Box my={-4}>
      <Button label={action.label} onPress={action.onPress} disabled={action.disabled} variant="link" tone="accent" size="xs" testID={action.testID} />
    </Box>
  );
}
