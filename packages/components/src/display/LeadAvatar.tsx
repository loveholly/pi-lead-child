import { useReducedMotion } from 'react-native-reanimated';

import { AvatarImage } from './AvatarImage';
import { FairyEye, type FairyEyeState, type FairyEyeTone } from './FairyEye';

// 形象从哪来（主题 11.12）：fairy-eye 是隐藏的 FairyEye 模式；image 是一张图（系统素材或用户上传的）。
// stillUri：系统开了「减少动态效果」时换成的静止图（思考中的动图用默认的静止图，F-8）。
export type LeadAvatarSource =
  | { kind: 'fairy-eye' }
  | { kind: 'image'; uri: string | null; stillUri?: string | null };

export type LeadAvatarProps = {
  source: LeadAvatarSource;
  size?: number;
  // 空闲还是思考中；color、muted、quiet 是 FairyEye 的色调，素材按它选淡彩和离线的图。
  state?: FairyEyeState;
  tone?: FairyEyeTone;
  // 无障碍标签：Lead 的名字，思考时加「在想」。
  name?: string;
  testID?: string;
};

// Lead 的形象（P12.8，主题 11.12）。调用方决定用哪个来源，这里只负责画。
export function LeadAvatar({ source, size = 18, state = 'idle', tone = 'color', name = 'Fairy', testID }: LeadAvatarProps) {
  const reduced = useReducedMotion();
  if (source.kind === 'fairy-eye') {
    return <FairyEye testID={testID} size={size} name={name} state={state} tone={tone} />;
  }
  const thinking = state === 'thinking' && tone === 'color';
  const uri = reduced && source.stillUri ? source.stillUri : source.uri;
  return <AvatarImage testID={testID} uri={uri} size={size} label={thinking ? `${name} 在想` : name} />;
}
