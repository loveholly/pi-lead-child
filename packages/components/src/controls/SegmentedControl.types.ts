export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
};

// 分段选择：在几个互斥的视图之间切换。web 上由 Tamagui 渲染；iOS 上是 UISegmentedControl，
// Android 上是 Compose SegmentedButton（Expo UI）。
export type SegmentedControlProps<T extends string> = {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  testID?: string;
  // 每一段的 testID。web 上每一段是独立的按钮，可以单独定位；原生控件只有整体的 testID。
  optionTestID?: (value: T) => string;
};
