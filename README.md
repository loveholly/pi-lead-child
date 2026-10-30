# pi-lead-child

pi-lead-child 是一个常驻的个人助理系统。Lead agent 接收你的请求，把工作拆成工单，再派给 child agent 执行。设计见 [DESIGN.md](DESIGN.md) 和 [docs/DESIGN-GATEWAY.md](docs/DESIGN-GATEWAY.md)。

## 仓库结构

仓库是一个 npm workspaces monorepo。`apps/` 放可运行的应用，`packages/` 放职责单一的子包。

```
apps/
  companion/    Expo 应用：web、iOS、Android 三端的工作台界面，是 daemon 的客户端
  cli/          plc 命令行：终端里的 daemon 客户端，也负责安装、启动和检查 daemon
  daemon/       常驻服务：coordinatord 入口和组装内核、网关、lead、supervisor 的组合根
packages/
  protocol/     daemon 网关和客户端之间的线协议：DTO schema、协议版本、配对
  client/       网关的 TypeScript 客户端：控制面 HTTP/WebSocket、凭据存储接口
  components/   三端统一 API 的基础组件库（Tamagui + Expo UI）
  core/         领域类型、配置、线上词汇和纯领域规则
  runtime/      agent runtime 适配器（pi、Codex、Claude）、失败分类、进程启动
  store/        SQLite 持久化：schema、迁移、仓储
  engine/       编排内核：调度、运行管线、child 管理、恢复
  gateway/      配对的 HTTP/WebSocket 网关、控制面投影、静态 web 界面托管
  supervisor/   守护 daemon 的 supervisor、launchd 安装、keychain、plc doctor
  lead/         lead agent：会话、模型配置、lead 的工具
```

## 依赖方向

依赖只能从上层指向下层。各个 app 之间互相不依赖。`apps/daemon/test/package-boundaries.test.ts` 检查这些规则，也检查依赖图没有环。

```
companion  →  components, client, protocol
client  →  protocol
core  →  protocol
runtime  →  core
store  →  core, runtime, protocol
engine  →  core, runtime, store, protocol
supervisor  →  core, runtime, store, protocol
gateway  →  core, runtime, store, engine, protocol
lead  →  core, runtime, store, engine, supervisor, protocol
daemon  →  所有后端包
cli  →  client, protocol, core（只用 core 找路径）
```

`cli` 和 `companion` 一样是 daemon 的客户端。它不打开账本，也不在前台运行内核。

## plc 和 daemon

`plc` 通过三条通道和 daemon 通信：

- 客户端动作走网关，和 companion 用同一个 `@pi-lead-child/client`：建单、列表、事项和 Run 的动作、授权、委托、重检、配对、aish 凭证、聊天。
- 运行时控制走 `supervisor.sock`：`plc daemon stop/status/restart/upgrade`。
- 安装、卸载、首次启动、没有 supervisor 时的停止、`plc doctor` 和 `plc lead model/use` 运行 daemon 的运维入口 `apps/daemon/dist/ops.mjs`。

### 网关在哪里监听

- 网关总是监听 `127.0.0.1`。没有配置 `PLC_GATEWAY_PORT` 时用 47130；这个端口被占用时改用随机端口。配置了端口时用那个端口，被占用时不改。
- 网关开到回环之外需要同时配置 `PLC_GATEWAY_HOST` 和 `PLC_GATEWAY_PORT`。只配了 host 时，它只监听回环，并在日志里警告。
- 配置的具体地址（局域网、Tailscale）另开一个监听，和回环共用端口。开机时这个地址可能还没就绪（例如 launchd 登录后 Tailscale 才连上），所以绑不上时在后台重试：1 秒起，每次翻倍，最多 60 秒一次，直到成功。回环地址一直可用。`plc daemon status` 和 `plc doctor` 显示这个地址的状态。
- 已经绑上的地址后来消失（网卡断开、Tailscale 退出）时，daemon 不重新绑定。同一个地址回来后，监听通常照常可用。地址换了（例如拿到新的局域网 IP）时，需要重启 daemon。
- 通配地址（`0.0.0.0`、`::`）不另开监听：网关只开这一个监听，它也包含回环。Linux 上通配地址不能和 `127.0.0.1` 共用一个端口。通配地址绑不上时，网关只监听回环，并在日志里警告；`plc daemon status` 显示 `stopped` 和原因。
- `plc` 每次请求、每次连接之前，都在 `plc.sock` 上问一次网关的地址，不缓存。

### 自动拉起

daemon 没有运行时，`plc` 先拉起它。下面两种情况不自动拉起，`plc` 报错并说明原因：

- 用户用 `plc daemon stop` 停过 daemon。没有 supervisor 时，`plc daemon stop` 也把这一点记进 `supervisor-state.json`。要启动，运行 `plc daemon start`。
- 维护（重启、备份、升级）正在进行。这时 `plc daemon start` 也被拒绝：等维护完成，supervisor 会自己拉起 daemon。

supervisor 在维护途中停掉时，下次启动把那条维护记录记成 `interrupted`，它不再挡住启动。拉起失败时，`plc` 报错并给出排查提示，不直接写账本。

### 凭证和信任边界

信任边界是系统用户。数据目录是 0700，`plc.sock`、`supervisor.sock` 和 `cli-credential.json` 是 0600：它们只挡别的系统用户。同一个用户的任何进程（包括 child agent）都能连上 `plc.sock` 换一个临时 admin token，也能读 `cli-credential.json`。那个凭证带 `tickets:create`，所以能做事项动作、对 lead 授权和委托。在同一个系统用户之内，这一点没法强制隔离。

下面几点只是纵深防御，用来减少暴露面和缩短泄露后的影响时间，不是隔离：

- `cli-credential.json` 只带 `chat`、`tickets:view`、`tickets:create`、`notices`，不带 `admin` 和 `approvals:respond`。
- 用户的决定（`approvals:respond`：审批、决定请求、连接的写入确认、记忆切换、常设指令的提议、「不是我」）只有本机网页和扫码配对的手机能做。`plc` 的凭证、`plc pair new` 建的配对、在本机兑换的邀请都做不了，因为 child 不伪造任何东西就能拿到它们。child 伪造本机网页的请求仍然能批，这时会推送给你，带「不是我」。经过和后续方案见 `.scratch/child-self-approve/options.md`。
- Lead 在你这一轮里代你做操作时，这一轮的凭证也要有这个操作的 scope。用 `plc` 的凭证开的一轮，Lead 不能代你批审批。
- 管理命令（`plc pair`、`plc aish`、`plc recheck`）每次在 `plc.sock` 上换一个临时 admin token。它只在 daemon 的内存里，5 分钟后作废，daemon 重启也作废，只能用于管理路由，`plc` 不把它写进文件。它被拒绝时，`plc` 换一个再试一次。
- `plc.db` 的每张表都有写入守卫（`packages/store/src/ledger-guard.ts`）。只有 daemon 和 `plc` 打开的连接能写；`sqlite3` 命令行能读（`sqlite3 -readonly`），写语句会失败。存心绕过的进程可以删掉触发器，daemon 每分钟发现一次、补装并推送。只回滚代码之前，先停 daemon，再运行 `plc daemon ledger-guard uninstall`：旧代码打开装过守卫的库会失败。
- 连接的权限设置（谁能用、写入策略）有保险库的封印，绑定连接和版本。绕过设置页的改动会被发现、恢复成更严的值，并直接推送给用户。设置页的改动是一次主人操作，带「不是我」。
- child 的命令里出现写 `plc.db` 或 `config.json` 的操作，会直接推送给用户。`config.json` 被 daemon 以外的进程改了，交给 Lead 告诉用户（多半是你自己手改的）。`plc lead use` 经 daemon 写，不算。
- child 的事件和 pi 的会话文件按值盖掉已知的密钥（名字像密钥的环境变量）。Lead 的 read、grep、find、ls 读不到凭证文件，结果里的密钥被盖掉。

2026-10-19 审查的经过和还没做的方案（例如用沙箱跑 child）见 `.scratch/permission-boundaries/spec.md`。

loopback 自动配对（`PLC_ALLOW_LOOPBACK_AUTO_PAIR=1`，`PLC_DEV=1` 时缺省打开）会越过这个边界。它只检查远端地址是回环、`Origin` 是网关自己的回环 origin。回环 TCP 端口不分系统用户，`Origin` 也可以伪造，所以同一台机器上的别的系统用户也能用它拿到一个带缺省 scope 的 binding。只在单用户的开发机上打开它。

`plc` 第一次需要网关时，在 `plc.sock` 上换一个 `kind=cli` 的凭证，存进 `cli-credential.json`。`plc auth status` 显示它对应的 binding。这个凭证被拒绝时，运行 `plc auth login` 重新签发。`plc auth login` 先用旧 token 向网关证明它是哪个 binding，确认是那个 `kind=cli` 的 binding 之后才撤销它。账本重置过时，binding 编号可能被别的设备复用，这时不撤销任何 binding。

### lead 自己发起的回合

lead 自己发起的回合也在会话流里，例如处理 blocker、播报即时通知、心跳巡检和整理笔记。这些回合的 `originKind` 以 `system:` 开头，没有发起的 binding，所以所有带 `chat` scope 的客户端都收得到。daemon 自己发出的 blocker 提示和兜底通知也是这样的回合。`plc chat` 和 companion 用 protocol 里的同一个函数 `systemTurnLabel` 给它们贴标签。用户发起的回合只发给发起的 binding。

"有人在听"只算同时满足下面三个条件的 v2 网关连接：

- 连接是活的。网关定时 ping，两个间隔内没有回应的连接被断开。
- 客户端说现在有人在看（`presence.set`）。companion 在应用处于前台（web 上是标签页可见）、并且 5 分钟内有过操作（点按、键盘、触摸、滚动）时上报 `attended: true`。`plc chat` 运行时、并且 5 分钟内有过输入时上报。这个时间是 protocol 里的 `PRESENCE_IDLE_MS`。什么都不报的连接不算，旧版 v1 连接也不算。
- binding 现在仍然有效，并且带 `chat` scope。每次计数都重新读账本。

即时通知的播报规则：

- lead 空闲、并且有人在听时，daemon 让 lead 开一轮播报。lead 正忙时不往当前回合里塞，等它空下来。
- 只有 lead 在这一轮里真的说了话、并且播完时仍然有人在听，通知才记为 lead 已送达。
- 一言不发或失败时，通知留在 pending，下次尝试按 15 秒起、每次翻倍、最多 5 分钟退避。同一条通知的重试复用同一轮，会话流里只留一轮。
- 播了但播完时没人在听：记下来，不再播第二遍。
- 没有送达的通知到了兜底窗口由兜底投递推出去；没人在听时还会弹桌面通知。

## 界面

`apps/companion` 的界面只从 `@pi-lead-child/components` 引入。应用不直接引入 react-native、Expo UI、Tamagui，也不写样式表。`apps/companion/src/uiBoundary.test.ts` 检查这条规则。组件库的用法见 [packages/components/README.md](packages/components/README.md)。

## 常用命令

```bash
npm install
```

```bash
npm run verify
```

```bash
npm run web
```

```bash
npm run plc -- daemon status
```

`npm run verify` 依次运行全部类型检查、测试、验收脚本和构建。修复缺陷时先运行 `npm run test:core-invariants`，再运行 `npm run verify`（见 [AGENTS.md](AGENTS.md)）。

## 构建产物

- `npm run build` 把 daemon 构建到 `apps/daemon/dist`，把 `plc` 构建到 `apps/cli/dist/cli.mjs`。
- `npm run build:web` 把 web 界面导出到 `apps/daemon/dist/web`，由网关托管。
- `plc` 命令在 `apps/cli/bin/plc`。它按 `apps/daemon/dist` 找 daemon 和 supervisor 的构建产物。
