import type { LeadAvatarSource } from '@pi-lead-child/components';

import { useLeadAvatar } from '@/state/hooks';

import { leadAvatarSource, type LeadAvatarLook } from './leadAvatarSource';

/** 画一个形象要的来源（./leadAvatarSource）。组件里用它，不要自己判断 fairyEye。 */
export function useLeadAvatarSource(look: LeadAvatarLook): LeadAvatarSource {
  const { leadAvatar, images } = useLeadAvatar();
  return leadAvatarSource(leadAvatar, images, look);
}
