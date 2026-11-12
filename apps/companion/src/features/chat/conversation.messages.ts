// 会话本身的文字（LeadConversation.tsx）、插话和排队的提示（steeredNotice.ts）、interrupt 横幅（InterruptBanner.tsx）、
// 停摆卡片（outagePresentation.ts）。
import { defineMessages } from '@/i18n';

export const conversationMessages = defineMessages({
  en: {
    header: {
      currentTicket: 'Current ticket',
      currentTicketTitle: (id: number) => `#${id} · Current ticket`,
      running: 'Running',
      runningCount: (count: number) => `Running ${count}`,
      openWorkList: 'Open the work list',
      openWorkspace: 'Open the workspace',
      hideViews: 'Hide custom views',
      showViews: 'Open custom views',
    },
    history: {
      unavailable: 'Cannot read earlier messages now.',
      failed: (error: string) => `Earlier messages did not load: ${error}`,
      loading: 'Loading earlier messages…',
      retry: 'Retry loading earlier messages',
      load: 'Load earlier messages',
    },
    cached: 'Cached conversation · waiting to reconnect',
    empty: {
      title: 'No conversation from the app yet',
      body: (name: string) =>
        `This is connected to the real ${name}. After you send the first message, the daemon writes the conversation and tool events here live.`,
      notConnectedTitle: (name: string) => `Not connected to ${name}`,
      notConnectedBody: (name: string) =>
        `Select ${name} at the top to set up the control plane. When it is not connected, no sample conversation is shown or written.`,
    },
    composer: {
      placeholder: (name: string) => `Message ${name}`,
      offline: 'Sends when the connection is back',
    },
    you: 'You',
    delivery: {
      pending: 'Waiting to send',
      pendingOffline: 'Waiting to send · sends when the connection is back',
      sending: 'Sending',
      delivered: 'Delivered',
      replying: 'Replying',
    },
    // 只发了图片的消息：失败卡里引用它时用这个词。
    imageOnly: '[Image]',
    yourImage: (index: number) => `Your image ${index}`,
    openTicket: (id: number) => `Open ticket #${id}`,
    repeatedInRow: (count: number, time: string) => `${count} times in a row · last at ${time}`,
    repeatedTotal: (count: number, time: string) => `${count} times · last at ${time}`,
    tail: {
      asked: (id: number, quoted: string) => `You asked in #${id}: "${quoted}"`,
      sent: (id: number) => `You sent a message in #${id}`,
      queued: (head: string) => `${head} · It cannot take messages while it works · Queued, delivered when it ends`,
      streaming: (head: string) => `${head} · Delivered · Answering`,
      failed: (head: string, name: string) => `${head} · Not delivered · Sent to ${name}`,
      steered: (head: string) => `${head} · Answered with the next message`,
      answered: (head: string, time: string) => `${head} · Delivered · Answered at ${time}`,
      label: (id: number) => `Ticket message to #${id}`,
    },
    syncing: 'Syncing card details.',
    footer: { starting: 'Starting', running: 'Running' },
    steered: {
      steered: (name: string) => `Steered in. ${name} sees it after the current step`,
      answeredTogether: 'Answered with the next message',
      nextTurn: (name: string) => `Next turn: ${name} answers it after the current turn`,
      cancelled: (name: string) => `Cancelled · not sent to ${name}`,
      queued: (name: string) => `In queue · ${name} answers it after this turn`,
      steeredIn: 'Steered in',
      nextTurnShort: 'Next turn',
      // Lead 的回答写到一半被你的插话打断：接在已经写出的字后面（主题 11.7 的接尾，2026-11-10）。
      interruptedBySteer: 'Interrupted by your message',
    },
    interrupt: {
      more: (count: number) => (count === 1 ? '1 more' : `${count} more`),
      notAcknowledged: (error: string) => `Not acknowledged: ${error}`,
      open: (id: number) => `Open #${id}`,
      acknowledge: 'Got it',
    },
    outage: {
      failures: (name: string, count: number, reason: string) =>
        `During this time, ${count === 1 ? '1 automatic task' : `${count} automatic tasks`} of ${name} did not finish (${reason})`,
    },
  },
  zh: {
    header: {
      currentTicket: '当前工单',
      currentTicketTitle: (id) => `#${id} · 当前工单`,
      running: '执行中',
      runningCount: (count) => `执行中 ${count}`,
      openWorkList: '打开工作列表',
      openWorkspace: '打开工作区',
      hideViews: '收起自定义视图',
      showViews: '打开自定义视图',
    },
    history: {
      unavailable: '暂时无法读取更早的消息。',
      failed: (error) => `更早的消息加载失败：${error}`,
      loading: '正在加载更早的消息…',
      retry: '重试加载更早的消息',
      load: '加载更早的消息',
    },
    cached: '显示已缓存会话 · 等待重新连接',
    empty: {
      title: '还没有来自 App 的会话',
      body: (name) => `这里已连接真实的 ${name}。发送第一条消息后，会话和工具事件会从 daemon 实时写入。`,
      notConnectedTitle: (name) => `尚未连接 ${name}`,
      notConnectedBody: (name) => `点击顶部的 ${name} 配置控制面。未连接时不会展示或写入任何模拟会话。`,
    },
    composer: {
      placeholder: (name) => `给 ${name} 发消息`,
      offline: '连接恢复后发送',
    },
    you: '你',
    delivery: {
      pending: '待发送',
      pendingOffline: '待发送 · 连接恢复后发送',
      sending: '发送中',
      delivered: '已送达',
      replying: '正在回复',
    },
    imageOnly: '[图片]',
    yourImage: (index) => `你发的图片 ${index}`,
    openTicket: (id) => `打开工单 #${id}`,
    repeatedInRow: (count, time) => `连续 ${count} 次 · 最近 ${time}`,
    repeatedTotal: (count, time) => `共 ${count} 次 · 最近 ${time}`,
    tail: {
      asked: (id, quoted) => `你在 #${id} 问了「${quoted}」`,
      sent: (id) => `你在 #${id} 发了一条消息`,
      queued: (head) => `${head} · 执行中不能插话 · 已排队，结束后转交`,
      streaming: (head) => `${head} · 已送达 · 正在回答`,
      failed: (head, name) => `${head} · 没送到 · 已交给 ${name}`,
      steered: (head) => `${head} · 和下一条一起回答`,
      answered: (head, time) => `${head} · 已送达 · ${time} 已回答`,
      label: (id) => `发给 #${id} 的工单消息`,
    },
    syncing: '正在同步卡片详情。',
    footer: { starting: '启动中', running: '运行中' },
    steered: {
      steered: (name) => `已插话，${name} 将在当前步骤后看到`,
      answeredTogether: '和下一条一起回答',
      nextTurn: (name) => `下一轮回答：${name} 答完当前这一轮以后接着答它`,
      cancelled: (name) => `已取消 · 没有发给 ${name}`,
      queued: (name) => `排队中 · ${name} 答完这一轮后回答`,
      steeredIn: '已插入',
      nextTurnShort: '下一轮回答',
      interruptedBySteer: '被你的插话打断',
    },
    interrupt: {
      more: (count) => `还有 ${count} 条`,
      notAcknowledged: (error) => `没有确认上：${error}`,
      open: (id) => `打开 #${id}`,
      acknowledge: '知道了',
    },
    outage: {
      failures: (name, count, reason) => `期间 ${name} 有 ${count} 次自动处理没有完成（${reason}）`,
    },
  },
});
