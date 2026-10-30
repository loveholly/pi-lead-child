import { Column } from '@pi-lead-child/components';

import { LeadAvatarSection } from './LeadAvatarSection';
import { LeadProfileSection } from './LeadProfileSection';

// 「身份与风格」页的内容：名字、人格、互动风格一张卡，形象一张卡（主题 11.15）。手机的 /settings/profile
// 和桌面上停在这一页的 /settings 用同一份。
export function LeadIdentitySettings() {
  return (
    <Column gap="page-section">
      <LeadProfileSection />
      <LeadAvatarSection />
    </Column>
  );
}
