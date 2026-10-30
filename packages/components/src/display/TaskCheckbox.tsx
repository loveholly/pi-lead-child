import { Box } from '../primitives/layout';
import { Icon } from './Icon';

export type TaskCheckboxProps = {
  checked: boolean;
  testID?: string;
};

// 任务列表的勾选框（Markdown 的 - [ ] 和 - [x]，GitHub 的样式）。只显示状态，不能点。
export function TaskCheckbox({ checked, testID }: TaskCheckboxProps) {
  return (
    <Box
      testID={testID}
      role="checkbox"
      aria-checked={checked}
      aria-disabled
      w={15}
      h={15}
      rounded="xs"
      borderWidth={1.5}
      borderColor={checked ? 'accent' : 'border-strong'}
      bg={checked ? 'accent' : 'surface'}
      items="center"
      justify="center"
    >
      {checked ? <Icon name="check" size={11} color="white" weight="bold" /> : null}
    </Box>
  );
}
