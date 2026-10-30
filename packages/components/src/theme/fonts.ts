import {
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_400Regular_Italic,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_700Bold_Italic,
  PlusJakartaSans_800ExtraBold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { useFonts } from 'expo-font';

import { fontFaces } from './tokens';

// 每个字重是一个独立加载的字体文件，名字和 tokens.fontFaces 一致。
const fontAssets = {
  [fontFaces.regular]: PlusJakartaSans_400Regular,
  [fontFaces.italic]: PlusJakartaSans_400Regular_Italic,
  [fontFaces.medium]: PlusJakartaSans_500Medium,
  [fontFaces.semibold]: PlusJakartaSans_600SemiBold,
  [fontFaces.bold]: PlusJakartaSans_700Bold,
  [fontFaces['bold-italic']]: PlusJakartaSans_700Bold_Italic,
  [fontFaces.extrabold]: PlusJakartaSans_800ExtraBold,
  [fontFaces['mono-medium']]: JetBrainsMono_500Medium,
  [fontFaces['mono-semibold']]: JetBrainsMono_600SemiBold,
  [fontFaces['mono-bold']]: JetBrainsMono_700Bold,
};

// 加载组件库用到的全部字体。返回 [loaded, error]，和 expo-font 的 useFonts 一样。
export function useUIFonts(): [boolean, Error | null] {
  return useFonts(fontAssets);
}
