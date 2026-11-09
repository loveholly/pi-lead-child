// 回合摘要里这一步现在的状态（AssistantTurnView.tsx，lead-scheduler spec D11）：等模型等过了 30 秒，不再一律写「Thinking」。
import { defineMessages } from '@/i18n';

export const turnStatusMessages = defineMessages({
  en: {
    modelSlow: 'The model is slow to reply',
  },
  zh: {
    modelSlow: '模型回复慢',
  },
});
