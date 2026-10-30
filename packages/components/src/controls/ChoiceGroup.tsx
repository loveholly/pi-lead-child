import { Badge } from '../display/Badge';
import { Pressable } from '../primitives/Pressable';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';

export type ChoiceOption = {
  id: string;
  label: string;
  /** 选了以后会怎样，写在名字下面。 */
  description?: string;
  /** 写在这一项右边的一句短说明，例如「现在用的」（radio）。 */
  aside?: string;
};

export type ChoiceGroupProps = {
  options: readonly ChoiceOption[];
  /**
   * cards：聊天卡片里的决定，每个选项是一张可以点的卡，点了就提交（onSelect），放不下时换行。
   * radio：单选卡（第四轮画板的「代码怎么处理」、换模型面板），竖着排，选中的那项高亮，由调用方另外提交。
   */
  variant?: 'cards' | 'radio';
  /** radio：选中的选项。 */
  value?: string | null;
  /** 推荐的选项：边框和底色高亮，名字旁边写「推荐」。 */
  recommended?: string;
  recommendedLabel?: string;
  onSelect?: (id: string) => void;
  disabled?: boolean;
  /** radio：这组单选的无障碍名称，例如「验收以后代码怎么处理」。 */
  accessibilityLabel?: string;
  testID?: string;
  /** 每个选项的 testID。 */
  optionTestID?: (id: string) => string;
};

// 一组互斥的选项。组件不存选中状态：value 和 onSelect 由调用方管。
export function ChoiceGroup({
  options, variant = 'cards', value = null, recommended, recommendedLabel = '推荐', onSelect, disabled = false,
  accessibilityLabel, testID, optionTestID,
}: ChoiceGroupProps) {
  if (variant === 'radio') {
    return (
      <Column testID={testID} role="radiogroup" aria-label={accessibilityLabel} gap="stacked-card">
        {options.map((option) => {
          const selected = option.id === value;
          return (
            <Pressable
              key={option.id}
              testID={optionTestID?.(option.id)}
              role="radio"
              aria-checked={selected}
              aria-label={option.label}
              disabled={disabled}
              onPress={() => onSelect?.(option.id)}
              flexDirection="row"
              items="flex-start"
              gap="side-item"
              px="row-x"
              py="row-y"
              rounded="md"
              borderWidth={selected ? 1.5 : 1}
              borderColor={selected ? 'accent' : 'border'}
              bg={selected ? 'accent-wash' : 'surface'}
            >
              <Box
                mt={1} // spacing-exempt: 光学对齐
                w={18}
                h={18}
                shrink={0}
                rounded="full"
                borderWidth={selected ? 5 : 1.5}
                borderColor={selected ? 'accent' : 'text-muted'}
                bg="surface"
              />
              <Column flex={1} minW={0}>
                <Row items="center" gap="inline-item">
                  <Text size="card-title" weight="bold">{option.label}</Text>
                  {option.id === recommended ? <Badge label={recommendedLabel} tone="accent" size="xs" /> : null}
                </Row>
                {option.description ? <Text size="secondary" tone="strong">{option.description}</Text> : null}
              </Column>
              {option.aside ? <Text shrink={0} size="meta" tone="strong">{option.aside}</Text> : null}
            </Pressable>
          );
        })}
      </Column>
    );
  }
  return (
    <Row testID={testID} gap="stacked-card" flexWrap="wrap">
      {options.map((option) => {
        const isRecommended = option.id === recommended;
        return (
          <Pressable
            key={option.id}
            testID={optionTestID?.(option.id)}
            aria-label={option.label}
            disabled={disabled}
            onPress={() => onSelect?.(option.id)}
            feedback="highlight"
            flex={1}
            minW={180}
            minH={44}
            px="row-x"
            py="row-y"
            rounded="lg"
            borderWidth={isRecommended ? 2 : 1}
            borderColor={isRecommended ? 'accent' : 'border'}
            bg={isRecommended ? 'accent-wash' : 'surface'}
          >
            <Column gap="text-stack">
              <Row items="center" gap="inline-item">
                <Text size="card-title" weight="bold" tone={isRecommended ? 'accent' : 'default'}>{option.label}</Text>
                {isRecommended ? <Badge label={recommendedLabel} tone="accent" /> : null}
              </Row>
              {option.description ? <Text size="secondary" tone="secondary">{option.description}</Text> : null}
            </Column>
          </Pressable>
        );
      })}
    </Row>
  );
}
