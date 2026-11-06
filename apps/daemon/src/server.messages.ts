// daemon（server.ts）发到会话里、界面上给用户看的文字：停摆卡片的每一行、Lead 没说的必须告诉用户的事、
// 排队消息的说明和错误、换模型的错误。按用户的语言写：写进数据库的按写入时的语言，读的时候现算的按读的时候的语言。
// 给 Lead 的系统事件和提示不在这里，照旧是中文。
import { defineMessages } from "@pi-lead-child/protocol";

export const serverMessages = defineMessages({
  en: {
    outage: {
      // 停摆卡片里一件事的状态。lead-outage.ts 读回时认「已推送给你」这一种（两种语言都认）。
      pushed: "Pushed to you",
      waiting: (name: string) => `Handled when ${name} recovers`,
      handedOver: (name: string) => `Handed to ${name}`,
      item: (line: string, status: string) => `· ${line} — ${status}`,
      ticket: (id: number, title: string, text: string) => `Ticket #${id} "${title}": ${text}`,
      note: (title: string, firstLine: string | null) => (firstLine === null ? title : `${title}: ${firstLine}`),
    },
    mustTell: {
      modelSwitched: (name: string, from: string, to: string, reason: string | null) =>
        `The model of ${name} changed from ${from} to ${to}.${reason ? ` Reason: ${reason}.` : ""}`,
      waitExpired: (name: string, note: string) => `${name} waited for something that did not complete before the timeout: ${note}`,
      triggered: (name: string, trigger: string, note: string) =>
        [trigger ? `${trigger}.` : "", note ? `(${name} wrote then: ${note})` : ""].filter(Boolean).join(" "),
      waitDone: (name: string) => `Something that ${name} waited for has a result.`,
    },
    queue: {
      heldExternal: "This turn read external content, so this message gets its own turn",
      heldNextTurn: "This message gets its own answer in the next turn. It cannot go into the running turn",
      sentence: (text: string) => `${text}.`,
      followUpGone: (turnId: string, name: string) =>
        `The queued message ${turnId} is not there now. It went to ${name}, or it does not exist`,
      turnDone: (name: string) => `${name} finished this turn. This message goes to ${name} now`,
      cannotChangeQueue: "This Lead session cannot change its queue",
      alreadyDelivered: (name: string) => `This message already went to ${name}`,
      cannotCancel: (name: string) => `This message already went to ${name}, so you cannot cancel it`,
      nothingQueued: (key: string) => `${key} has no queued messages now`,
      answeredWithFollowUp: "Answered together with the queued message after it",
      answeredWithSteer: "Answered together with the message that came in after it",
      steerSeen: (name: string) => `This message reached the running turn. ${name} read it and did not answer separately`,
    },
    model: {
      cannotSwitchWhileRunning: "This Lead session cannot change the model while it runs",
      switchFailed: (wanted: string, current: string) => `Cannot change to ${wanted}. ${current} is still in use`,
    },
    // Lead 的模型连续失败到上限，系统不再自动叫醒它（#21）。
    wakeRetry: {
      stoppedTitle: (name: string, failures: number) => `${name}'s model failed ${failures} times in a row. Automatic retries stopped`,
      stoppedBody: (name: string) =>
        `Check the model and key in Settings. Changing them, sending ${name} a message or restarting the daemon tries again; `
        + `waiting events go to ${name} after the first successful turn.`,
    },
    // /stop：daemon 对这条命令的回答，以及停下的那一轮末尾加的一句。
    stop: {
      stopped: (name: string) => `Stopped the turn that ${name} was running.`,
      idle: (name: string) => `${name} is not running a turn now. There is nothing to stop.`,
      note: "Stopped with /stop.",
    },
  },
  zh: {
    outage: {
      pushed: "已推送给你",
      waiting: (name) => `等 ${name} 恢复后处理`,
      handedOver: (name) => `已交给 ${name}`,
      item: (line, status) => `· ${line} —— ${status}`,
      ticket: (id, title, text) => `工单 #${id}「${title}」：${text}`,
      note: (title, firstLine) => (firstLine === null ? title : `${title}：${firstLine}`),
    },
    mustTell: {
      modelSwitched: (name, from, to, reason) => `${name} 的模型从 ${from} 换成了 ${to}。${reason ? `原因：${reason}。` : ""}`,
      waitExpired: (name, note) => `${name} 在等的事到了超时还没有完成：${note}`,
      triggered: (name, trigger, note) => `${trigger ? `${trigger}。` : ""}${note ? `（${name} 当时记下：${note}）` : ""}`,
      waitDone: (name) => `${name} 在等的事有了结果。`,
    },
    queue: {
      heldExternal: "这一轮读过外部内容，这条要单独开一轮",
      heldNextTurn: "这条排在下一轮单独回答，插不进正在跑的这一轮",
      sentence: (text) => `${text}。`,
      followUpGone: (turnId, name) => `排着的追问 ${turnId} 不在了：它已经交给 ${name}，或者不存在`,
      turnDone: (name) => `${name} 已经答完这一轮了，这条马上就交给它`,
      cannotChangeQueue: "这个 Lead 会话不能改排队",
      alreadyDelivered: (name) => `这条已经交给 ${name} 了`,
      cannotCancel: (name) => `这条已经交给 ${name} 了，取消不了`,
      nothingQueued: (key) => `${key} 现在没有排着的消息`,
      answeredWithFollowUp: "和后面的排队消息一起回答",
      answeredWithSteer: "和后面的插话一起回答",
      steerSeen: (name) => `插话送到了这一轮，${name} 看过了，没有另外回答`,
    },
    model: {
      cannotSwitchWhileRunning: "这个 Lead 会话不能在运行中换模型",
      switchFailed: (wanted, current) => `换不到 ${wanted}，还在用 ${current}`,
    },
    wakeRetry: {
      stoppedTitle: (name, failures) => `${name} 的模型连续失败 ${failures} 次，已停止自动重试`,
      stoppedBody: (name) =>
        `请在设置里检查模型和 key。改了它们、给 ${name} 发一条消息或者重启 daemon 都会再试；`
        + `等着的事在第一次成功的回合以后交给 ${name}。`,
    },
    stop: {
      stopped: (name) => `已停下 ${name} 正在进行的一轮。`,
      idle: (name) => `${name} 现在没有在进行的一轮，不需要停。`,
      note: "已用 /stop 停下。",
    },
  },
});
