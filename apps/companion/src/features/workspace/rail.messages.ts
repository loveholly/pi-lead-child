// 工作台左栏（WorkRail、CompactWorkspaceNav、TicketList）的文案。
import { defineMessages } from '@/i18n';

export const railMessages = defineMessages({
  en: {
    views: { conversation: 'Conversation', inbox: 'Inbox', tickets: 'Tickets', projects: 'Projects', agenda: 'Agenda' },
    runsRunning: (n: number) => (n === 1 ? '1 ticket is running' : `${n} tickets are running`),
    noRunsRunning: 'No ticket is running',
    settings: 'Settings',
    // 工单卡片上的小标签：这张工单登记了 PR。
    pullRequestChip: (short: string) => `PR ${short}`,
    searchPlaceholder: 'Search title, number, project',
    searchLabel: 'Search tickets',
    // 第一次用时的示例：点了填进输入框，发给 Lead。
    starterCommands: (index: number) => [
      'Help me plan the three most important things for today',
      'Check the current project for the risks that need action first',
      'Create a new task and split it into steps',
    ][index] ?? '',
  },
  zh: {
    views: { conversation: '对话', inbox: '收件箱', tickets: '工单', projects: '项目', agenda: '日程' },
    runsRunning: (n) => `${n} 张工单在执行`,
    noRunsRunning: '没有工单在执行',
    settings: '设置',
    pullRequestChip: (short) => `PR ${short}`,
    searchPlaceholder: '搜索标题、编号、项目',
    searchLabel: '搜索工单',
    starterCommands: (index) => [
      '帮我规划今天最重要的三件事',
      '审计当前项目里最需要处理的风险',
      '创建一个新任务并拆成可执行步骤',
    ][index] ?? '',
  },
});
