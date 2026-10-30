import type { FontSizeToken } from '../theme/tokens';

// outline：白底描边。filled：浅灰底、深一些的描边。plain：无底无边，嵌在别的容器里（例如消息输入条）。
export type TextFieldVariant = 'outline' | 'filled' | 'plain';
export type TextFieldSize = 'sm' | 'md' | 'lg';

// 单行或多行文字输入。web 上是 Tamagui 样式的输入框；iOS 和 Android 上是 SwiftUI TextField /
// Compose TextField（Expo UI）。value 是受控的普通字符串，两端一样。
export type TextFieldProps = {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  variant?: TextFieldVariant;
  size?: TextFieldSize;
  // 字号覆盖。缺省按 size 取。
  fontSize?: FontSizeToken;
  mono?: boolean;
  disabled?: boolean;
  multiline?: boolean;
  // 多行输入框的高度。缺省按 size 取单行高度作为最小高度。
  height?: number;
  secure?: boolean;
  // 自动填充的提示。填 key 的输入框用 new-password：地址框后面跟着密码框，看起来像登录表单，
  // 浏览器可能把保存的密码填进来，再当作 API key 发给别的服务。iOS 上 Expo UI 把它转成 textContentType。
  autoComplete?: 'off' | 'new-password';
  autoFocus?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  keyboardType?: 'default' | 'url' | 'email-address' | 'number-pad';
  returnKeyType?: 'done' | 'go' | 'next' | 'search' | 'send';
  maxLength?: number;
  // 占满一行里剩下的宽度。
  grow?: boolean;
  // accent：边框用强调色，web 上外面一圈 accent-soft 光晕（主题 11.2「改一下再发」：草稿框原地变成输入框）。
  emphasis?: 'accent';
  onSubmit?: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  testID?: string;
  accessibilityLabel?: string;
};
