import type { BadgeTone } from '../display/Badge';
import type { TextTone } from '../primitives/Text';
import type { ColorToken } from '../theme/tokens';

// 展示数据的组件（Stats、Steps、Progress、Timeline、BarChart）共用的五种色调。
// 名字和 genui 卡片里的 tone 一样，genui 可以直接传进来。
export type DataTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

// 色调在徽章上的颜色。
export const dataToneBadge: Record<DataTone, BadgeTone> = {
  neutral: 'neutral', info: 'accent', success: 'success', warning: 'warning', danger: 'danger',
};

// 色调在文字上的颜色。
export const dataToneText = {
  neutral: 'default', info: 'accent', success: 'success-dark', warning: 'warning-dark', danger: 'danger-dark',
} as const satisfies Record<DataTone, TextTone>;

// 条形、进度条和时间线圆点的填充色。没给色调时用强调色。
export function dataToneFill(tone: DataTone | undefined): ColorToken {
  return tone ? FILL[tone] : 'accent';
}

const FILL: Record<DataTone, ColorToken> = {
  neutral: 'text-muted', info: 'accent', success: 'success', warning: 'warning', danger: 'danger',
};
