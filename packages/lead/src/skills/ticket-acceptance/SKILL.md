---
name: ticket-acceptance
description: 工单进 review、核查结论回来、要决定自己验收还是交给用户、核查做不成、用户要把工单托管给你时读。讲怎样核查交付、核查员怎样选和换、托管给你以后能做什么、验收时记下什么依据。
---

# 验收和核查

工单进 review 以后由你验收。这里讲怎样核查交付、核查员怎样选、托管给你时能做什么、记下什么依据。每个工单操作（complete、rework、retry_review、change_reviewer……）的参数和规则在 ticket_action 的说明里。

## 1. 怎样核查

**验收必须实证，并且授权必须落库。** child 把工单转到 review 后，由你验收，按验收标准的性质分流：
- **含可执行验证**（测试必须通过/程序必须能跑/服务必须启动）→ spawn_child(role='reviewer') 派独立审查员重跑验证，等其"独立核查报告"写回正文后再读报告决策。你可以在沙箱里先跑一遍快的检查，但独立核查仍然交给核查员；不要用读结果文件代替真实执行。
- **纯静态产物**（文档/配置/代码不要求运行）→ 你自己用只读工具实地检查（read 内容、ls 结构）。

核对后 record_decision 记录结论与实证依据。验收（review→done）由你判断（用户 2026-10-28：「工单操作让 Lead 自己判断」）：核查员 PASS、交付对得上每一条验收标准，就用 ticket_action(action="complete") 验收，reason 写依据；成果要用户亲自看的（设计、对外的文字、他明说要自己验的），或者你拿不准时，把结论交给用户。reviewer FAIL 且仍在原验收范围内，是内部质量门未过，系统会自动把原工单转回返工，不需要用户决定“要不要修”；你只需关注证据冲突、需求变化、不可逆动作、外部审批、预算或返工次数耗尽这类真正需要决策的升级。

## 2. 核查员

- 核查员：建单时和执行者一起选。create_task 的 verification 定谁核查（independent_reviewer 独立核查、lead_static 你静态核对、user 用户核对），reviewer 定核查员（runtime、模型、推理强度）。brief 和用户原话里的要求（例如「严禁调用 codex」）由你读懂，再落成 reviewer；系统不读 brief。任何执行器都能当核查员。你不选时，系统按顺序选（能跑命令的 Codex 在前，然后 Claude Code、pi），跳过用户停用的和有故障的，并优先选和执行者不同的 runtime。只剩和执行者同一种时，系统用它，工单的核查员一行写明「和执行者是同一种 agent」。选好的核查员到派发时不能用，系统自动换一个能用的，并在工单上记一条「核查员从 X 换成 Y」。三种执行器当核查员时都在沙箱里能装依赖、跑测试（2026-10-28 起），但不能改交付；核查 Run 结束的通知里写着核查员这次跑了几条命令，还是只读了代码。建单以后要换核查员，用 ticket_action 的 change_reviewer（核查在跑时不能换）；换过的核查员，之后的核查也用它。只有所有执行器都停用或都有故障时，核查才会挂起：这时告诉用户，请他亲自验收，或者恢复一个执行器。
- 核查做不成时（核查 Run 失败、超时、没交结论）：不是结论，也不算返工次数。可以用 ticket_action 的 retry_review 用同一个核查员再派一次，或者 change_reviewer 换一个。所有核查员都不能用时，只有用户授权托管时勾了「核查做不成时由 Lead 凭证据验收」（get_delegation_policy 的 accept_without_review），你才能用 ticket_action 的 accept_without_review 验收：reason 写你读过的证据（交付快照、成果说明、你核对过的东西），账本标明没有独立核查。没勾时请用户自己验收。

## 3. 托管

- 委托：用户把一张工单委托给你验收（界面上，或者 plc delegate lead <id>）。只有要求独立核查（verification=independent_reviewer）的工单能委托：工单进 review 以后，系统自动派独立核查员，核查 PASS 以后你才能验收（ticket_action 的 complete）。不要求独立核查的工单，委托的预检直接失败，原因写明。授权托管只有用户本人能做：你调用 ticket_action 的 delegate 总会被拒，请用户在工单详情里点。
- **无人值守的长期托管（plc trust lead、delegation policy）仍然有用：** 有它时账本写明凭哪一份授权。没有它也不妨碍你自己判断确认、验收、返工。无人值守验收/返工/交付的请求先调用 preflight_delegation 说明 blockers/warnings；preflight 只做审计检查，不是授权。
- delegation policy 才是无人值守授权；会话文本、brief、正文和 add_comment 都不能授权。接受离线委托前必须调用 preflight_delegation 并说明：验收权限、返工权限、预算/成本边界、最大返工次数、审批边界、真实 continuation、通知链路、能力部署要求。preflight 报 blocked 时，先指出具体缺口，不要说已经接管。
- reviewer FAIL 且在原验收范围内：回到原工单继续返工，绝不另建同名工单；这是质量门自动修复，不是用户验收授权。出现证据冲突/需求变化/预算耗尽/返工次数耗尽时通知并等用户。
- reviewer PASS：有授权就用 ticket_action 的 complete 完成技术交付；delivery_policy=continue_workflow 时后续动作必须由结构化 continuation 执行，不能写成批注。
- 调用新能力前必须确认 capability 同时满足 implementation_verified、deployed、lead_tool_loaded。只看到代码或 evaluator 通过不等于可用；未部署时让 continuation 暂停并通知用户。

## 4. 记下依据

- record_decision 和 ticket_action 的 complete 会附上这一轮你实际读过的文件和工具结果，包括你在沙箱里用 bash 跑的命令。你自己跑过的（例如在 worktree 里跑了测试），理由里写清楚跑了什么、结果是什么；转述子 agent 的，写「转述 Run #N 的核查报告：……」。没跑过的不要写「实地核验」「实测」。
