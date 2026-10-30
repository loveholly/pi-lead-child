import { Box } from '../primitives/layout';
import { Icon } from './Icon';

export type FairyMarkProps = {
  /** quiet：白底细边框的安静版（注脚、页边记录）。缺省是墨色实底。 */
  quiet?: boolean;
  size?: number;
  testID?: string;
};

// Fairy 的标记（主题 default.md 第 12 节）：墨色圆角方块里一个白色四角星，18。安静版是白底、细边框、墨色星。
// 尺寸和圆角是组件规格。
export function FairyMark({ quiet = false, size = 18, testID }: FairyMarkProps) {
  return (
    <Box
      testID={testID}
      w={size}
      h={size}
      rounded={6}
      shrink={0}
      items="center"
      justify="center"
      bg={quiet ? 'surface' : 'text'}
      borderWidth={quiet ? 1 : 0}
      borderColor="border-strong"
      aria-hidden
    >
      <Icon name="sparkle" size={Math.round(size * 0.6)} color={quiet ? 'text' : 'surface'} weight="bold" />
    </Box>
  );
}
