import type { IconName } from '../display/icons';
import type { ColorToken, RadiusToken } from '../theme/tokens';

// solid：实底。outline：白底描边。soft：浅色底。ghost：无底，悬停时出浅底。link：只有文字。
export type ButtonVariant = 'solid' | 'outline' | 'soft' | 'ghost' | 'link';
// accent：主操作（蓝）。neutral：普通操作。inverse：深色实底。danger：危险操作。success：确认类操作（绿）。
export type ButtonTone = 'accent' | 'neutral' | 'inverse' | 'danger' | 'success';
// 高度：xs 28、sm 32、md 38、lg 44、xl 48。
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

// 文字按钮。web 上由 Tamagui 渲染；iOS 和 Android 上是 SwiftUI / Jetpack Compose 的原生按钮（Expo UI）。
// 两端用同一份 props，外观由 Button.shared.ts 的同一份规格算出。
// 需要放任意内容（卡片、列表行）时用 Pressable。
export type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  tone?: ButtonTone;
  size?: ButtonSize;
  shape?: 'rounded' | 'pill';
  icon?: IconName;
  iconPosition?: 'start' | 'end';
  disabled?: boolean;
  // 占满父容器的宽度。
  fullWidth?: boolean;
  testID?: string;
  accessibilityLabel?: string;
};

// 只有图标的按钮。label 用作无障碍名称和缺省的 testID。
export type IconButtonProps = {
  icon: IconName;
  label: string;
  onPress?: () => void;
  variant?: Exclude<ButtonVariant, 'link'>;
  tone?: ButtonTone;
  size?: ButtonSize;
  disabled?: boolean;
  // 右上角的红点，表示有需要处理的事。
  badge?: boolean;
  iconSize?: number;
  iconColor?: ColorToken;
  rounded?: RadiusToken;
  testID?: string;
};
