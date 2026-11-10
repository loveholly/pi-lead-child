# 工单 #285：会话卡片里的表单（演示和截图）

2026-11-06 在执行沙箱里跑的演示：在会话里给一条直觉填地址、模型和 key，提交后设置页里能看到，test_fast_model 测通。

## 怎么跑的

- daemon 是真的：网关、Lead 的工具（render_ui、perform_action）、设置 → 模型、记忆服务的决策测试都是仓库里的代码，数据目录是新建的临时目录。
- Lead 的会话是替身：用户说「帮我配一条直觉」时，它调真的 render_ui 画一个绑定 `save_fast_model` 的表单；表单提交的结果叫醒它时，它调真的 `perform_action(test_fast_model)`，把结果写进会话。
- 决策网关是测试替身：本机 `127.0.0.1:47291` 上的一个小服务，只认用户在卡片里填的那个 key（演示用的假 key）。
- 页面是 `build:web` 导出的 companion，由 daemon 的网关提供，Chrome 打开 `http://127.0.0.1:47233/`。桌面版加载的是同一份网页。

## 截图

| 文件 | 内容 |
|---|---|
| `1-initial.png` | 初始态：名字和模型有缺省值，地址是占位，Key 是密码框，旁边可以临时显示 |
| `2-validation-error.png` | 校验报错：地址写成 `decision.example.com`、Key 没填，点保存后两个标签变红，操作组左边写第一条原因，卡片不变高，什么都没发给 daemon |
| `3-secret-input.png` | 敏感输入：Key 填好后只显示圆点；说明里写「加密保存，Lead 看不到这个值」 |
| `4-submitted.png` | 提交成功：卡片收成一行结果「已提交 · 添加一条直觉 · 添加了直觉 公司决策（127.0.0.1:47291）」；结果叫醒 Lead，Lead 接着调 test_fast_model，测通（179 毫秒） |
| `5-settings-shows-it.png` | 设置 → 模型：直觉里多了「公司决策 · 127.0.0.1:47291 · decision-1 · Key is set」 |

界面语言是缺省的英文，所以系统的文字（Fields marked * are required、Submitted）是英文；卡片里的标题、字段名是 Lead 写的中文。Lead 的名字是测试数据目录的缺省名字。

## 核对

- 假网关的日志：`POST /v1/systemone key=matched`，说明 test_fast_model 用的是用户在卡片里填、daemon 存进保险库的那个 key。
- 账本：`ui_action.performed` 记的是 `actor=user`、`authority=user`；`ui_form.submitted` 里 apiKey 只有 `{"secret":"set"}`。
- 在演示的数据目录里 grep key 的原值：数据库（WAL 合并以后）和 daemon 日志里都没有。
