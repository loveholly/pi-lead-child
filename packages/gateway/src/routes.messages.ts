// 网关的路由回给界面的错误、主人操作的摘要和 OAuth 回调页的文字（2026-11-01 多语言）。
// 按请求时用户选的语言（store 的 getLocale）写。只回给 Lead 工具的错误不在这里。
import { CHANNEL_SECRET_MAX_LENGTH, defineMessages } from "@pi-lead-child/protocol";

const error = (value: unknown) => (value instanceof Error ? value.message : String(value));

export const routeMessages = defineMessages({
  en: {
    // ── 工单、交付 ──
    ticketNotFound: (id: number) => `Ticket #${id} does not exist`,
    deliveryNumber: "delivery is the delivery number, a positive integer",
    deliveryNotFound: (id: number, delivery: string | null) => `Ticket #${id} has no delivery ${delivery ?? ""}`.trimEnd(),
    expectedHead: "expectedHead must be a full commit SHA.",
    expectedTarget: (max: number) => `expectedTarget must be a branch name of 1 to ${max} characters.`,
    deliveryView: "view must be full or diff.",
    positiveInteger: (name: string) => `${name} must be a positive integer.`,
    ticketNumber: "The ticket number",
    deliverySequence: "The delivery number",

    // ── 设置页的服务 ──
    connectionsUnavailable: "Connections did not start yet",
    memoryUnavailable: "Memory settings did not start yet",
    runtimeUnavailable: "Executor settings did not start yet",
    channelsUnavailable: "Message channels did not start yet",
    notLocalPage: "Only a web page on this computer can change channel credentials. The gateway uses plain HTTP, so secrets cannot go over the LAN",
    channelNotFound: "This channel does not exist",
    secretsBody: `The request body must be {secrets: {name: value}}. Each value is a string of 1 to ${CHANNEL_SECRET_MAX_LENGTH} characters`,
    unknownSecrets: (names: string) => `This channel does not know these secret names: ${names}`,
    joinNames: (names: string[]) => names.join(", "),
    checksFailed: "Not all checks passed. Nothing was saved",
    leadModelsUnavailable: "Model switching for Lead did not start yet",
    leadModelsFailed: (cause: unknown) => `Cannot read the model catalog: ${error(cause)}`,
    modelSettingsUnavailable: "Model settings did not start yet (the Lead session is not ready)",
    modelSettingsFailed: (cause: unknown) => `Cannot read the model settings: ${error(cause)}`,
    hindsightUnavailable: "This daemon does not host the memory service (Hindsight)",
    hindsightFailed: (cause: unknown) => `Cannot read the status of the memory service: ${error(cause)}`,
    autoBudgetUnavailable: "The limits on automatic model calls are not ready yet (Lead did not start)",

    // ── Lead 的形象 ──
    avatarImageId: "The image id is not valid",
    avatarImageNotFound: "This image does not exist",
    avatarCodeTooLong: "code is too long. A Slack shortcode has at most 100 characters",
    avatarSlackUnavailable: "This daemon cannot look up Slack emoji.",
    avatarEmojiBody: "The request can only have emoji (text) and reset (true or false)",

    // ── 确认卡、常设指令 ──
    ruleChangeNotFound: (id: string) => `Confirmation card ${id} does not exist`,
    timerRequestNotFound: (id: string) => `Timer confirmation card ${id} does not exist`,
    orderNotFound: (id: string) => `Standing order ${id} does not exist`,
    proposalNotFound: (id: number) => `Standing order proposal #${id} does not exist`,

    // ── 主人操作的摘要 ──
    orderTarget: (title: string) => `Standing order "${title}"`,
    orderRolledBack: (title: string, to: number, written: number) =>
      `Rolled back standing order "${title}" to v${to} (new version v${written})`,
    proposalDecided: (approve: boolean, lead: string, title: string, id: number, summary: string) =>
      `${approve ? "Approved" : "Rejected"} the proposal #${id} of ${lead} to change standing order "${title}": ${summary}`,
    connectionConfirmationTarget: (label: string) => `Write confirmation of ${label}`,
    connectionConfirmed: (approve: boolean, label: string, summary: string) =>
      `${approve ? "Allowed" : "Did not allow"} ${label} to write: ${summary}`,
    memorySwitchTarget: "Memory switch",
    memorySwitchConfirmed: (approve: boolean, summary: string) => `${approve ? "Agreed to" : "Did not agree to"} the memory switch: ${summary}`,

    // ── OAuth 回调页（浏览器里打开） ──
    htmlLang: "en",
    oauthNotHereTitle: "You cannot complete the authorization here",
    oauthNotHereDetail: (lead: string) => `Authorization can only return to the Mac that runs ${lead}.`,
    oauthUnavailableDetail: (lead: string) => `Go back to ${lead} later and connect again.`,
    oauthConnectedTitle: (label: string) => `${label} is connected`,
    oauthConnectedDetail: (lead: string) => `You can close this page and go back to ${lead}.`,
    oauthFailedTitle: "The authorization did not complete",
    oauthFailedDetail: (lead: string) => `Something went wrong. Go back to ${lead} and connect again.`,
  },
  zh: {
    ticketNotFound: (id) => `工单 #${id} 不存在`,
    deliveryNumber: "delivery 是第几次交付，一个正整数",
    deliveryNotFound: (id, delivery) => `工单 #${id} 没有第 ${delivery} 次交付`,
    expectedHead: "expectedHead 要是一个完整的提交 SHA。",
    expectedTarget: (max) => `expectedTarget 要是一个 1 到 ${max} 个字符的分支名。`,
    deliveryView: "view 只能是 full 或 diff。",
    positiveInteger: (name) => `${name} 要是一个正整数。`,
    ticketNumber: "工单号",
    deliverySequence: "交付序号",

    connectionsUnavailable: "连接功能还没有启动",
    memoryUnavailable: "记忆设置还没有启动",
    runtimeUnavailable: "执行器设置还没有启动",
    channelsUnavailable: "消息通道还没有启动",
    notLocalPage: "只有这台电脑上的网页能改通道的凭据：网关是明文 HTTP，密钥不能经过局域网",
    channelNotFound: "没有这个通道",
    secretsBody: `请求体要是 {secrets: {名字: 值}}，值是 1 到 ${CHANNEL_SECRET_MAX_LENGTH} 个字符的字符串`,
    unknownSecrets: (names) => `这个通道不认这些密钥名：${names}`,
    joinNames: (names) => names.join("、"),
    checksFailed: "检查没有全部通过，没有保存",
    leadModelsUnavailable: "Lead 的模型切换还没有启动",
    leadModelsFailed: (cause) => `读不到模型目录：${error(cause)}`,
    modelSettingsUnavailable: "模型设置还没有启动（Lead 的会话还没建好）",
    modelSettingsFailed: (cause) => `读不到模型设置：${error(cause)}`,
    hindsightUnavailable: "这台 daemon 不托管记忆服务（Hindsight）",
    hindsightFailed: (cause) => `读不到记忆服务的状态：${error(cause)}`,
    autoBudgetUnavailable: "自动调用模型的上限还读不到（Lead 还没有启动）",

    avatarImageId: "图的 id 不对",
    avatarImageNotFound: "没有这张图",
    avatarCodeTooLong: "code 太长：Slack 的短代码最多 100 个字符",
    avatarSlackUnavailable: "这个 daemon 查不了 Slack 的 emoji。",
    avatarEmojiBody: "请求只能有 emoji（文字）和 reset（true 或 false）",

    ruleChangeNotFound: (id) => `没有确认卡 ${id}`,
    timerRequestNotFound: (id) => `没有定时器的确认卡 ${id}`,
    orderNotFound: (id) => `没有常设指令 ${id}`,
    proposalNotFound: (id) => `没有常设指令的提议 #${id}`,

    orderTarget: (title) => `常设指令「${title}」`,
    orderRolledBack: (title, to, written) => `把常设指令「${title}」回滚到 v${to}（新版本 v${written}）`,
    proposalDecided: (approve, lead, title, id, summary) =>
      `${approve ? "批准" : "拒绝"}了 ${lead} 对常设指令「${title}」的修改提议 #${id}：${summary}`,
    connectionConfirmationTarget: (label) => `${label} 的写入确认`,
    connectionConfirmed: (approve, label, summary) => `${approve ? "允许" : "不允许"}${label}写入：${summary}`,
    memorySwitchTarget: "记忆切换",
    memorySwitchConfirmed: (approve, summary) => `${approve ? "同意" : "不同意"}记忆切换：${summary}`,

    htmlLang: "zh-CN",
    oauthNotHereTitle: "不能在这里完成授权",
    oauthNotHereDetail: (lead) => `授权只能回到运行 ${lead} 的这台 Mac。`,
    oauthUnavailableDetail: (lead) => `请稍后回到 ${lead} 重新连接。`,
    oauthConnectedTitle: (label) => `${label} 已连接`,
    oauthConnectedDetail: (lead) => `可以关闭这个页面，回到 ${lead}。`,
    oauthFailedTitle: "授权没有完成",
    oauthFailedDetail: (lead) => `出了点问题，请回到 ${lead} 重新连接。`,
  },
});
