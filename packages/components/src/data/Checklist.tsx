import { Badge, type BadgeTone } from '../display/Badge';
import { Icon } from '../display/Icon';
import { Pressable } from '../primitives/Pressable';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';

// 一列判定的表头，例如「核查员」。还没有结论的格子显示一条短横，无障碍名称用 emptyLabel。
export type ChecklistColumn = { label: string; emptyLabel?: string };

// 一格判定，例如核查员的「通过」「不通过」。null 是还没有结论。
export type ChecklistVerdict = { label: string; tone?: BadgeTone } | null;

export type ChecklistItem = {
  id: string;
  label: string;
  /** 每一列判定一格，和 columns 一一对应。 */
  verdicts?: readonly ChecklistVerdict[];
  /** 最后一列的勾选（例如「你」确认达到）。 */
  checked?: boolean;
  /** 这一条不通过：整行标红。 */
  failed?: boolean;
  /** 写在这一条下面的一句证据，例如为什么不通过。 */
  evidence?: string;
};

export type ChecklistProps = {
  items: readonly ChecklistItem[];
  /** 判定的几列。不给时没有判定列。 */
  columns?: readonly ChecklistColumn[];
  /** 勾选那一列的表头，例如「你」。不给时没有勾选列。 */
  checkColumn?: string;
  /** 点勾选框。不给时勾选框只显示，不能点。 */
  onToggle?: (id: string, checked: boolean) => void;
  /** 勾选框的无障碍名称。缺省是「确认：<这一条>」。 */
  checkLabel?: (item: ChecklistItem, index: number) => string;
  /** 每一条前面的编号。 */
  numbered?: boolean;
  testID?: string;
};

const VERDICT_WIDTH = 76;
const CHECK_WIDTH = 36;

// 逐条对照的清单：每条一行，右边几列判定，最后一列勾选（第四轮画板的验收标准）。
export function Checklist({
  items, columns = [], checkColumn, onToggle, checkLabel, numbered = true, testID,
}: ChecklistProps) {
  const hasCheck = checkColumn !== undefined;
  return (
    <Column testID={testID}>
      {columns.length > 0 || hasCheck ? (
        // spacing-exempt: 表头列间距加光学对齐
        <Row aria-hidden items="center" gap={8} mt={2}>
          <Box flex={1} />
          {columns.map((column, index) => (
            <Text key={index} w={VERDICT_WIDTH} shrink={0} align="center" size="label" weight="bold" tone="secondary">{column.label}</Text>
          ))}
          {hasCheck ? <Text w={CHECK_WIDTH} shrink={0} align="center" size="label" weight="bold" tone="secondary">{checkColumn}</Text> : null}
        </Row>
      ) : null}
      {items.map((item, index) => (
        <Column
          key={item.id}
          testID={testID ? `${testID}-item-${item.id}` : undefined}
          {...(item.failed ? { mx: -8, px: 8, pt: 6, pb: 8, rounded: 'sm', bg: 'danger-surface' } : { py: 6 })}
        >
          {/* spacing-exempt: 各列之间的间距 */}
          <Row items="flex-start" gap={8}>
            {numbered ? (
              <Box w={20} h={20} shrink={0} rounded="full" borderWidth={1} borderColor="border-strong" bg="surface" items="center" justify="center">
                {/* spacing-exempt: 圆圈内的序号字号 */}
                <Text size="11" leading={15} weight="bold" tone="strong">{String(index + 1)}</Text>
              </Box>
            ) : null}
            <Text flex={1} minW={0} size="card-title" weight="semibold">{item.label}</Text>
            {columns.map((column, cell) => (
              <VerdictCell key={cell} column={column} verdict={item.verdicts?.[cell] ?? null} />
            ))}
            {hasCheck ? (
              <Box w={CHECK_WIDTH} shrink={0} items="center">
                <CheckBox
                  checked={item.checked === true}
                  label={checkLabel ? checkLabel(item, index) : `确认：${item.label}`}
                  onPress={onToggle ? () => onToggle(item.id, item.checked !== true) : undefined}
                  testID={testID ? `${testID}-check-${item.id}` : undefined}
                />
              </Box>
            ) : null}
          </Row>
          {item.evidence ? (
            <Text ml={numbered ? 28 : 0} mt="text-stack" size="secondary" tone="strong">{item.evidence}</Text>
          ) : null}
        </Column>
      ))}
    </Column>
  );
}

function VerdictCell({ column, verdict }: { column: ChecklistColumn; verdict: ChecklistVerdict }) {
  if (!verdict) {
    return (
      // spacing-exempt: 文字当图标用
      <Text w={VERDICT_WIDTH} shrink={0} align="center" size="13" leading={20} tone="muted" role="img" aria-label={column.emptyLabel ?? `${column.label}还没有结论`}>
        —
      </Text>
    );
  }
  return (
    <Box w={VERDICT_WIDTH} shrink={0} items="center">
      <Badge label={verdict.label} tone={verdict.tone} size="xs" />
    </Box>
  );
}

// 18 的勾选框，外面一圈 28 的点按区域（上下各收回 4，不撑高这一行）。
function CheckBox({ checked, label, onPress, testID }: { checked: boolean; label: string; onPress?: () => void; testID?: string }) {
  const box = (
    <Box
      w={18}
      h={18}
      rounded="xs"
      borderWidth={checked ? 0 : 1.5}
      borderColor="text-muted"
      bg={checked ? 'accent' : 'surface'}
      items="center"
      justify="center"
    >
      {checked ? <Icon name="check" size={12} color="white" weight="bold" /> : null}
    </Box>
  );
  return (
    <Pressable
      testID={testID}
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={onPress ? undefined : true}
      onPress={onPress}
      feedback={onPress ? 'opacity' : 'none'}
      cursor={onPress ? 'pointer' : 'default'}
      w={28}
      h={28}
      my={-4} // spacing-exempt: 负边距保持行高
      items="center"
      justify="center"
    >
      {box}
    </Pressable>
  );
}
