// 工单详情的「核查证据」（ReviewEvidence.tsx，工单 #503）的文字。
import { defineMessages } from '@/i18n';

export const reviewEvidenceMessages = defineMessages({
  en: {
    // 折叠行收着时的摘要：「3 screenshots · criteria 1, 2」。
    summary: (count: number, criteria: string | null) => {
      const shots = count === 1 ? '1 screenshot' : `${count} screenshots`;
      return criteria ? `${shots} · ${criteria}` : shots;
    },
    // 一张证据对应的标准：「Criterion 2」「Criteria 1, 3」。
    criteria: (numbers: readonly number[]) => (numbers.length === 1 ? `Criterion ${numbers[0]}` : `Criteria ${numbers.join(', ')}`),
    // 证据对应的标准后来删掉了。
    removedCriterion: 'A removed criterion',
    // 工单没有验收标准时。
    noCriterion: 'No criterion',
    // 补挂的证据（核查结束以后挂上的）。
    addedLater: (by: string) => `Attached after the review by ${by}`,
    you: 'you',
    openImage: (label: string) => `${label}, open the large image`,
  },
  zh: {
    summary: (count, criteria) => (criteria ? `${count} 张截图 · ${criteria}` : `${count} 张截图`),
    criteria: (numbers) => `标准 ${numbers.join('、')}`,
    removedCriterion: '已删掉的标准',
    noCriterion: '没有对应的标准',
    addedLater: (by) => `核查结束以后由${by}补挂`,
    you: '你',
    openImage: (label) => `${label}，打开大图`,
  },
});
