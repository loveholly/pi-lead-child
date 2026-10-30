import { Pressable } from '../primitives/Pressable';
import { Row } from '../primitives/layout';
import { Text } from '../primitives/Text';

export type OptionPill = { label: string; value: string };

export type OptionPillsProps = {
  options: readonly OptionPill[];
  /** 选中的那个选项的 value。没有选中时为 null。 */
  selected: string | null;
  onSelect: (value: string) => void;
  /** 给读屏的这一组的名字，例如「改到什么时候」。 */
  label: string;
  disabled?: boolean;
  testID?: string;
};

// 一排可以选一个的选项胶囊（genui v3 积木 6 的常用选项，2026-10-27）。
// 清爽主题：白底、border-strong 描边、全圆角（C-7、R-4）；选中时 accent-wash 底、强调色的边和字（S-3、I-6），整行不加底。
export function OptionPills({ options, selected, onSelect, label, disabled = false, testID }: OptionPillsProps) {
  return (
    <Row testID={testID} role="radiogroup" aria-label={label} flexWrap="wrap" gap="chips">
      {options.map((option, index) => {
        const on = option.value === selected;
        return (
          <Pressable
            key={`${option.value}-${index}`}
            testID={testID ? `${testID}-${index}` : undefined}
            role="radio"
            aria-checked={on}
            aria-label={option.label}
            disabled={disabled}
            onPress={() => onSelect(option.value)}
            feedback="highlight"
            rounded="full"
            borderWidth={1}
            borderColor={on ? 'accent' : 'border-strong'}
            bg={on ? 'accent-wash' : 'surface'}
            px="inline-item"
            py="text-stack"
          >
            <Text size="label" weight="semibold" tone={on ? 'accent' : 'default'} numberOfLines={1}>{option.label}</Text>
          </Pressable>
        );
      })}
    </Row>
  );
}
