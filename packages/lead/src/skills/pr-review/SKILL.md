---
name: pr-review
description: 用户要你评审一个 GitHub PR 之前读（「review 这个 PR」「帮我看看这个改动」「作者推了新提交，再看一遍」）。讲怎样派评审 agent、评审由谁发到 PR、用户要先看时怎么办、结论回来以后怎样告诉用户。评审本身看什么、怎样定结论，写在模板给评审 agent 的说明里。
---

# 评审 PR

评审派轻子 agent 做，你不自己读 diff。PR 的 diff 和评审全文很大，读进你的上下文会挤掉别的事：2026-10-28 的停顿就是从 Lead 读进一份交回的评审和 PR 的文件开始的。

## 1. 派活

1. create_task(template='pr_review', review_pull_request=N, light=true)，再 spawn_child。N 是 PR 编号，workdir 写那个仓库。
2. pr_review 里的 focus 和 acceptance 逐字抄用户的原话，不要改写。模板把它们原样写进 brief，再加上固定的护栏；验收标准由系统按行抄成结构化的几条，acceptance_criteria 不要另给。你的补充写在 brief 里，没有补充时给空字符串。
3. review_pull_request 让每个 Run 在 PR head 的临时检出里跑，Run 结束就删。不要让 child 在用户的工作副本里 fetch 或 checkout PR 分支。

## 2. 评审由谁发

- 缺省 deliver='post'：评审 agent 自己发到这个 PR（建待提交的评审、逐条加行内评论、提交），只能写这个 PR，交回的是一句话和评审的链接。用户说「PR 评审直接发行内评论」就是这种做法。
- 用户说「先给我看看」时用 deliver='return'：评审只交回、不发，交回说明写着它有多长。你读完自己发，或者再派一个轻子 agent 去发。
- review_events 缺省是 COMMENT 和 REQUEST_CHANGES。用户明确要 approve 时才加上 APPROVE。读过外部内容的一轮里，系统不给 APPROVE。

## 3. 结论回来以后

- 你只读结论，转告用户，不要把评审全文和 PR 的 diff 读进自己的上下文。
- 转告之前，用 GitHub 连接读这个 PR 的 review 列表，核对远端的 state 和评审 agent 说的结论一致：有阻塞问题时应该是 CHANGES_REQUESTED。对不上时如实告诉用户，不要照 agent 的自述转告。
- 发不出去时（例如 GitHub 拒绝了结论），交回说明里写着原因。按「被拦住以后」一节找下一条路。

## 4. 同一个 PR 再审一遍

作者推了新提交、用户要再看一遍，是同一个目标：按 skill ticket-planning 第 3 步留在原评审工单上，不要另建一张。在 add_comment 里写清这一轮要看什么（新提交、上一轮的问题改了没有），再照那一步的做法打回原工单。每个 Run 都在 PR 最新的 head 上检出，评审的发布权限也按 Run 重新给。

## 5. 外部通道里有人要评审

别人在 Slack 等外部通道里请用户评审 PR 时，按 skill channel-replies 的派活规则处理。那里的子 agent 能做多少，由那条消息的权限上限决定。
