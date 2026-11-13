// 工作台左栏（WorkRail、CompactWorkspaceNav、TicketList）的文案。
import { defineMessages } from '@/i18n';

export const railMessages = defineMessages({
  en: {
    views: { conversation: 'Conversation', inbox: 'Inbox', tickets: 'Tickets', projects: 'Projects', agenda: 'Agenda' },
    runsRunning: (n: number) => (n === 1 ? '1 ticket is running' : `${n} tickets are running`),
    noRunsRunning: 'No ticket is running',
    settings: 'Settings',
    searchPlaceholder: 'Search title, number, project',
    searchLabel: 'Search tickets',
    // 停太久的暂停工单（工单 #111）：行上直接继续或取消。取消在原地再确认一次（设计规范 P5.3）。
    paused: {
      resume: 'Resume',
      resuming: 'Resuming…',
      cancel: 'Cancel ticket',
      cancelQuestion: 'Cancel this ticket?',
      confirmCancel: 'Cancel it',
      cancelling: 'Cancelling…',
      keep: 'Keep it',
    },
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
    searchPlaceholder: '搜索标题、编号、项目',
    searchLabel: '搜索工单',
    paused: {
      resume: '继续',
      resuming: '正在继续…',
      cancel: '取消工单',
      cancelQuestion: '取消这张工单？',
      confirmCancel: '确认取消',
      cancelling: '正在取消…',
      keep: '先不',
    },
    starterCommands: (index) => [
      '帮我规划今天最重要的三件事',
      '审计当前项目里最需要处理的风险',
      '创建一个新任务并拆成可执行步骤',
    ][index] ?? '',
  },
});
