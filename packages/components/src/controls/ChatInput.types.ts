// 会话输入框里的多行文字输入。缺省一行高，内容多了自动长高，到上限以后在框里滚动。
// web 上：Enter 调 onSubmit，Shift+Enter 换行，输入法正在组字时按 Enter 不调（确认候选词）；粘贴剪贴板里的图片调 onPasteFiles。
// iOS 和 Android 上是 Expo UI 的多行输入框：键盘的回车换行，发送用旁边的按钮；没有粘贴图片。
// 外框（底色、描边、圆角）由调用方画，这里只有文字。
export type ChatInputProps = {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  onSubmit?: () => void;
  // 剪贴板里有图片、没有文字时，粘贴调它，图片不插进文字里。剪贴板里有文字时照常粘贴文字。
  onPasteFiles?: (files: Blob[]) => void;
  onBlur?: () => void;
  autoFocus?: boolean;
  testID?: string;
  accessibilityLabel?: string;
};
