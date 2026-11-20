---
name: slack-messaging
description: 写发到 Slack 的话之前读（回复对方、代用户发消息、写卡上的草稿、改消息）：Slack 消息的格式怎样写、怎样排、什么时候进 thread、什么时候回表情就够了。处理消息的流程（派活、回复、告诉用户）在 skill channel-replies。
---

# 写 Slack 消息

这份 skill 改写自 Slack 官方的 `slack-messaging` skill（slackapi/slack-skills-plugin，commit ce93a2ca，MIT 许可，见同目录的 LICENSE）。官方原文写的是 Slack MCP 的工具；这里换成了你的工具，删掉了你用不到的部分（定时发送）。canvas 和 Markdown 文件一节是本地加的。

## 格式

照常写标准 Markdown。系统发到 Slack 时，把你写的话换成 Slack 的 mrkdwn。不要自己写 mrkdwn（`*粗体*`、`~删除线~`）：单个星号会被当成斜体。

| 格式 | 写法 |
| --- | --- |
| 粗体 | `**text**` |
| 斜体 | `_text_` |
| 删除线 | `~~text~~` |
| 行内代码 | `` `code` `` |
| 引用 | `> text` |
| 链接 | `[文字](url)` |
| 列表 | `- item` 或 `1. item` |

- 代码块照常用三个反引号。语言名会去掉，Slack 不按语言着色。
- 标题（`#`、`##`）在 Slack 里变成一行粗体。
- Slack 不画表格：表格会原样放进代码块。要对齐的信息少时，改用列表。
- 图片（`![alt](url)`）不会显示成图片，只是一个链接。
- 提到人时写 `@名字`，名字照对话里看到的写（例如 `@Nina Wang`）。系统发送时把它换成 Slack 的提及，对方会收到通知。知道编号时也可以写 `<@U123>`。同名的人有两个以上时，系统不换，所以名字要写全。

用户本人逐字给的原话（send_channel_message 的 words=user）原样发，系统不换格式。

## 消息的结构

- **先说重点。** 第一行放最重要的信息。很多人在手机或通知里只看到第一行。
- **写短。** 一到三个短段落就够。长的、有结构的内容，先问自己对方是不是真的需要全部。
- **多换行。** 不同的意思之间空一行，不写一整块字。
- **三项以上用列表**，不挤在一个长句里。
- **粗体只给关键信息**：名字、日期、截止时间、要对方做的事。

## thread 和频道

- 回应一条具体的消息时，回在它的 thread 里。reply_to_source 已经这样做：频道和私信都回在对方那条消息下面的 thread 里，没有 thread 就开一个。
- 开新话题、发公告、问整个频道一个问题时，才发到频道或私信的根上（send_channel_message 的对话编号用 `:main` 的那个）。
- 接着一件已经在聊的事说时，不要另开一个 thread：找到原来那条消息，回在它的 thread 里（对话编号用那个 thread 的，例如 read_channel_conversation 的消息上 `thread=` 后面的编号）。

## 长内容：canvas 和 Markdown 文件

方案、清单、会议纪要、报告这类长的、要留着、要一起改的内容，不要塞进一条消息。用 create_channel_document 建一份文档，再在消息里用一两句话说重点，附上链接。

- **canvas**（kind=canvas）：大家能一起编辑、勾清单。放进频道（给 conversation）时它挂成频道的 canvas 标签页。不放进对话时只有用户能看，要把链接发给对方。
- **Markdown 文件**（kind=markdown）：对方要下载、转给别的工具，或者要一份固定的原文时用。给 conversation 时文件分享到那个对话或 thread 里。Slack 不能原地改文件：edit_channel_document 会换一份新的，编号跟着变。

canvas 的 Markdown 和消息不一样，系统不转换，原样交给 Slack：

- 标题用 `#`、`##`、`###`。清单用 `- [ ]` 和 `- [x]`。
- 表格可以用，一张表最多 300 格。
- 提到人写 `![](@U123)`，提到频道写 `![](#C123)`。
- 代码块不能放在列表项里，否则 Slack 拒绝整份文档。

改 canvas 的一段以前，先用 read_channel_document 读一遍，再照抄那一段里的一句作为 section。

## 语气

- 语气跟着对话走：正式的频道写得正式一些，熟人的私信可以随意一些。系统提示词里的「代回复风格」优先。
- 只是表示收到、同意、感谢时，回一个表情（react_channel_message）就够了，不用发一条消息。
- 写通知、公告时按这个顺序：背景、关键信息、要对方做什么。
