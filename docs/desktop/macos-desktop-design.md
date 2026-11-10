# Bytezard Lead 桌面版（macOS）设计方案

状态：定稿。用户 2026-11-03 拍板的决定见第 9 节。本文只做设计和拆单，不改代码。
范围：只做 macOS，只出 Apple 芯片（arm64）版。产品对外叫「Bytezard Lead」，所有对外文案都用这个名字。

## 0. 结论摘要

- App 是一个**薄壳**：Electron 只负责首次安装、显示安装进度和失败原因、打开一个窗口加载 daemon 网关提供的网页。业务界面仍然是现有的 Companion 网页。
- daemon 和 supervisor 照旧是用户级 launchd 常驻进程，launchd label 是 `com.bytezard.plc.supervisor`。它们跑在一份**版本化的运行包**（runtime bundle）上：自带 Node（文件名改成 `lead-agent`）、构建好的 dist、Web 构建、better-sqlite3、pi、uv。
- 数据目录是 `~/Library/Application Support/Bytezard Lead/`。运行包装在它下面的 `runtime/versions/<版本>/`，`runtime/current` 软链接指向在用的版本。
- 部署闸门按根目录有没有 `release.json` 分成两种模式。有 `release.json` 是发布模式：校验版本号、架构和关键文件的 SHA-256。没有就是开发模式：照旧按 git commit 判断。
- Electron 自带的自动更新要求 App 签名，我们没有证书，所以不用它。更新分两层：运行包由 supervisor 的 upgrade 流程自动换（P1），Lead 可以自己触发，事后告诉用户；App 壳有新版时只提示（P1），自动替换放到 P2。
- GitHub Actions 在 release 发布（`release: published`）时，在 arm64 runner 上打包，dmg 和运行包作为附件挂到 release。dmg 用 ad-hoc 签名（不是 Apple 证书），不公证。
- 未签名带来两个要在 P0 实测的风险：通知能不能发出来，「登录项与扩展」里显示什么名字（P0-7）。

## 1. 结构图

### 1.1 进程和目录

下文用两个简写：

- `<数据目录>` = `~/Library/Application Support/Bytezard Lead/`
- `<安装根>` = `<数据目录>/runtime/`

```
/Applications/Bytezard Lead.app          ← Electron 薄壳（用户拖进去）
  Contents/Info.plist                    ← CFBundleName = Bytezard Lead，CFBundleIdentifier = com.bytezard.plc
  Contents/Resources/runtime/bytezard-lead-runtime-<ver>-arm64.tar.gz   ← 随 App 带的运行包（首次安装用），就是发布附件，不改名

~/Library/Application Support/Bytezard Lead/   ← 数据目录（plc.db、config.json、sockets、logs、backups）
  runtime/                               ← 安装根（install root）
    versions/
      1.3.0/                             ← 一个版本的运行包，装好后只读
        release.json                     ← 版本、架构、关键文件哈希（发布模式的标志）
        package.json                     ← {"workspaces": []}，让 projectRoot() 照旧找到根
        bin/lead-agent                   ← nodejs.org 官方 Node 24 二进制，改名为 lead-agent
        bin/node -> lead-agent           ← 给 `#!/usr/bin/env node` 的脚本用
        bin/uv  bin/uvx                  ← Hindsight 用（P1）
        bin/plc                          ← CLI 包装脚本
        apps/daemon/package.json
        apps/daemon/dist/{supervisor,coordinatord,ops,mcp-server,hindsight}.mjs
        apps/daemon/dist/launcher-shim.mjs
        apps/daemon/dist/web/            ← Companion 静态导出
        apps/cli/dist/cli.mjs
        node_modules/                    ← 只有 esbuild 的 external：better-sqlite3、pi、sandbox-runtime 及其依赖
                                           2026-11-05 起是软链接，指向 ../../shared/node_modules/<哈希>/node_modules（第 7.5 节）
      1.2.0/                             ← 上一个版本，留作回滚
    shared/node_modules/<哈希>/node_modules/   ← 按内容哈希存的 node_modules，内容一样的版本共用一份（第 7.5 节）
    current -> versions/1.3.0
    install-state.json                   ← 安装向导的进度和最后一次错误
  shell/                                 ← Electron 的 userData（缓存、窗口状态），和业务数据分开

~/Library/LaunchAgents/com.bytezard.plc.supervisor.plist
  ProgramArguments = [ <安装根>/current/bin/lead-agent, <安装根>/current/apps/daemon/dist/supervisor.mjs ]
~/Library/LaunchAgents/com.bytezard.plc.hindsight.plist   ← Hindsight 的独立任务（P1）；2026-11-05 起不再有，Hindsight 由 supervisor 拉起（第 8.7 节）
```

- daemon 由 supervisor 拉起，不单独注册 launchd 任务。supervisor 用自己的 `process.execPath` 启动 daemon，所以 daemon 的进程名也是 `lead-agent`。
- Hindsight 现在就是一个独立的 launchd 任务（`packages/supervisor/src/deploy/hindsight.ts:25` 的 `HINDSIGHT_LABEL`），按同一个前缀改成 `com.bytezard.plc.hindsight`。
- Electron 的 `userData` 缺省就是 `~/Library/Application Support/<productName>/`，和数据目录同一个位置。壳在 `ready` 之前调用 `app.setPath("userData", <数据目录>/shell)`，不让 Chromium 的缓存文件混进数据目录的根。

### 1.2 运行关系

```
 用户双击 App
     │
     ▼
 Electron 主进程 ──(首次)── 解出运行包 → versions/<ver> → 去掉 quarantine → current 软链接
     │                         │
     │                         └─ 运行 current/bin/lead-agent ops.mjs desktop-install --progress-json
     │                               ├─ 采集登录 shell 的 PATH → <数据目录>/login-shell-path.json
     │                               ├─ 写 plist，launchctl bootstrap gui/<uid>
     │                               ├─ 等 supervisor.sock，发 ensure_running
     │                               └─ 等 plc.sock 回答 status，拿到 gatewayUrl
     │
     ├─ 连 <数据目录>/plc.sock，读 status.gatewayUrl
     ├─ 订阅 daemon 的桌面通知，用 Electron Notification 发（第 8.6 节，P0-7 实测后选定）
     └─ BrowserWindow 加载 http://127.0.0.1:<port>/   ← 回环自动配对，请求带 shell-pairing.key 的口令（P0-4，见 shell.md）
                                   │
                                   ▼
                        Companion：FirstRunBrain（接服务商、填 key、选模型）
                                   │
                                   ▼
                        新增一步：选执行器（Codex / Claude Code / pi）

 launchd ── KeepAlive ──▶ supervisor ──spawn──▶ coordinatord（daemon） ──▶ codex / claude / pi 执行器
     （进程名都是 lead-agent）   ▲
                                 └── request_maintenance{upgrade, targetVersion}（P1：换 current，再重启）
```

App 关掉以后，supervisor 和 daemon 照旧在跑。App 只是一个窗口、安装器和通知的出口。

## 2. 发布包的结构（问题 1）

### 2.1 结论

| 组成 | 来源 | 放在哪里 |
|---|---|---|
| Node | nodejs.org 官方 Node 24 的 darwin-arm64 二进制，固定版本，用 `SHASUMS256.txt` 校验，改名为 `lead-agent`，重新做 ad-hoc 签名（第 8.7 节） | `bin/lead-agent`；`bin/Bytezard Lead` 和 `bin/node` 是指向它的软链接，launchd 的 plist 写 `bin/Bytezard Lead` |
| daemon、supervisor、ops、mcp-server、hindsight 的 dist | `npm run build` | `apps/daemon/dist/` |
| plc CLI | `apps/cli` 的构建 | `apps/cli/dist/cli.mjs`，`bin/plc` 包装 |
| Web 构建 | `npm run build:web` | `apps/daemon/dist/web/` |
| better-sqlite3、pi、sandbox-runtime | 在 CI 上用同一个 Node 版本 `npm install --omit=dev` 到一个暂存目录，只装这三个 external | `node_modules/` |
| uv | astral 的 GitHub Releases 单文件二进制，固定版本，校验哈希（P1） | `bin/uv`、`bin/uvx` |
| release.json | 打包脚本生成 | 根目录 |

P0-2 的实现没有再跑一次 `npm install`：它按根 `package-lock.json` 算这三个 external 的依赖闭包，从仓库装好的 `node_modules` 复制。原因和用法见 [runtime-bundle.md](runtime-bundle.md)。

理由：

- **daemon 用独立的 Node，不用 Electron 自带的 Node。** daemon 的生命周期和 App 无关（用户已经定了）。如果用 `ELECTRON_RUN_AS_NODE` 跑 daemon，换 Electron 版本就会改变 daemon 的 Node ABI，better-sqlite3 也要按 Electron 重新编译。用独立的 Node，原生模块和开发环境一样按 Node ABI 构建，不需要 electron-rebuild。pi 1.1.0 要求 Node `>=22.19.0`（`node_modules/@earendil-works/pi-coding-agent/package.json` 的 engines），Node 24 满足。
- **nodejs.org 的 Node 二进制是官方构建**，Node 下载页提供 `node-v24.x.y-darwin-arm64.tar.gz` 和 `SHASUMS256.txt`（[nodejs.org/dist/latest-v24.x](https://nodejs.org/dist/latest-v24.x/)）。
- **Node 改名为 `lead-agent`**（第 9 节决定 6、7）：「活动监视器」里看到的是 `lead-agent`，不是 `node`。只改名时登录项归到「Node.js Foundation」下面（P0-7 实测），所以 Node 重新做 ad-hoc 签名，launchd 的 plist 写软链接 `bin/Bytezard Lead`，登录项显示 Bytezard Lead，见第 8.7 节。
- **运行包沿用仓库的目录形状**（`apps/daemon/dist`、根 `package.json` 带 `workspaces`），所以 `projectRoot()`、`distDir()`、`defaultWebRoot()`、pi 的 `locateExecutable`（`join(cwd, "node_modules", ".bin", "pi")`）都不用改（`packages/core/src/config.ts:33-48`，`packages/runtime/src/pi.ts:573`）。P0 先求少改；以后要换成显式的安装根，再单独做。
- **不把整个仓库的 node_modules 打进去。** `apps/daemon/scripts/build.ts` 已经把所有后端包打进 `.mjs`，运行时只靠三个 external（`build.ts` 的 `external` 数组）。

### 2.2 安装位置和版本目录

- 安装根：`<数据目录>/runtime/`。不用 `/Applications` 里的 App 包本身，原因有两个：
  - App 从下载目录或 dmg 里直接打开时，macOS 可能把它搬到一个随机的只读路径运行（App Translocation）。plist 不能指向这种路径。
  - App 被替换或删掉时，常驻的 daemon 不能跟着失效。
- 安装根放在数据目录下面，这样一个产品只有一个目录。卸载时只删 `runtime/` 和 `shell/`，数据默认保留（第 4.4 节）。
- 每个版本一个目录 `versions/<版本>/`，装好后不再改。`current` 是软链接。换版本时先建临时软链接，再 `rename` 覆盖 `current`，这一步是原子的。
- 保留两个版本：`current` 和上一个，留作回滚。更早的版本在升级成功后删掉：`desktop-install` 装好、daemon 回答以后删（`packages/supervisor/src/deploy/runtime-versions.ts`，2026-11-05）。还有进程在用的版本不删（daemon、Hindsight 和接管过来的执行器从 `versions/<版本>/` 运行）；不知道上一个是哪个版本时一个都不删。
- 服务正在用的版本也不删（`install-state.json` 的 `serviceVersion`）：只改了网页的更新不重启服务，服务可能还跑在更早的版本上（第 7.5 节）。删完版本以后，`shared/node_modules/` 里没有版本再指向的项也删掉。
- 开发安装和桌面安装用同一个数据目录。开发机从旧名字迁过来，见 P0-8。
- plist 里写 `current` 的路径，不写具体版本。Node 运行 `import.meta.url` 时会解开软链接，所以 `ops.mjs desktop-install` 要显式接收 `--root <安装根>/current`，不能靠 `projectRoot()` 推出来。
- 新路径里有空格（`Application Support`、`Bytezard Lead`）。所有路径都用 `execFile` 的参数数组传，不拼进 shell 命令。给模型看的文字里，命令要带引号，例如 `sqlite3 -readonly ~/"Library/Application Support/Bytezard Lead/plc.db"`。
- macOS 的 Unix socket 路径最长 104 字节。`/Users/<用户名>/Library/Application Support/Bytezard Lead/plc.sock` 在用户名不超过 40 个字符时够用。desktop-install 和 P0-8 的迁移先检查长度，超出时报一个明确的错误，不让 daemon 在 listen 时才失败。

### 2.3 release.json

```json
{
  "schema": 1,
  "product": "bytezard-lead",
  "version": "1.3.0",
  "arch": "arm64",
  "node": "24.22.2",
  "schemaVersion": 63,
  "sourceTree": "<构建用的 git tree 哈希>",
  "builtAt": "2026-11-03T08:00:00Z",
  "updateSource": { "type": "github", "repository": "<owner>/<repo>" },
  "files": {
    "bin/lead-agent": "<sha256>",
    "apps/daemon/dist/supervisor.mjs": "<sha256>",
    "apps/daemon/dist/coordinatord.mjs": "<sha256>",
    "apps/daemon/dist/ops.mjs": "<sha256>",
    "apps/daemon/dist/mcp-server.mjs": "<sha256>",
    "apps/daemon/dist/launcher-shim.mjs": "<sha256>",
    "apps/daemon/dist/web/index.html": "<sha256>",
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node": "<sha256>"
  }
}
```

- `updateSource.repository` 在 CI 里取 `${{ github.repository }}`，代码和文档里不写死仓库名。
- `schemaVersion` 是这次构建的 `LATEST_SCHEMA_VERSION`，用来拒绝会让库无法打开的降级（第 3 节）。
- `arch` 只会是 `arm64`。闸门仍然检查它，防止有人在别的机器上手动装错包。

## 3. 部署闸门的发布模式（问题 2）

### 3.1 结论

闸门按**根目录有没有 `release.json`** 选模式，不按环境变量选。launchd 的环境里没有用户的环境变量，按文件判断在每条路径上都一致。

| 检查 | 开发模式（没有 release.json） | 发布模式（有 release.json） |
|---|---|---|
| 来源 | 主 checkout 没有没提交的改动；dist 从干净的 commit 构建；commit 在当前分支历史里（现有 `deployReadiness`） | `release.json` 能解析，`schema` 认识 |
| 完整性 | `build-info.json` 存在且 `dirty=false` | `files` 里每个文件的 SHA-256 都对得上 |
| 架构 | 不查 | `release.json.arch === process.arch` |
| 位置 | 不查 | `current` 解析后在 `<安装根>/versions/` 下面 |
| 降级 | 不查 | 库的 schema 版本大于 `release.json.schemaVersion` 时拒绝 |

理由：

- 普通用户的机器上没有 git，也没有 checkout。现在的 `deployReadiness` 会因为读不了 git 状态直接拒绝（`packages/supervisor/src/deploy/readiness.ts:100-108`）。
- 发布模式要防的是**半装好的目录和损坏的文件**，例如解压中断、磁盘满了。它不防同一个用户下的恶意进程：那种进程能改任何文件，哈希也挡不住。
- 只给关键文件算哈希，不扫整个 `node_modules`。status 会被频繁调用，现在的缓存是 30 秒（`server.ts` 的 `READINESS_CACHE_MS`），哈希十来个文件的开销可以接受。
- 降级检查防的是：旧代码打开新 schema 的库会失败。

### 3.2 实现要点

- 在 `packages/supervisor/src/deploy/` 新增 `release.ts`：`readReleaseManifest(root)`、`releaseReadiness(root, installRoot, dbPath)`。
- `deployReadiness(root, distDir)` 改成先看 `release.json`：有就走 `releaseReadiness`，没有就走现有逻辑。返回类型 `DeployReadiness` 加一个 `mode: "dev" | "release"` 和 `release` 字段，`head`/`build` 在发布模式下为 null。
- `supervisor/src/main.ts` 的 `runsFromDist()` 不变。`deployment` 多传一个 `installRoot`（发布模式才有）。
- `plc daemon start --force` 的绕过在两种模式下都保留，照旧记日志。

## 4. 首次安装向导（问题 3）

### 4.1 用户看到什么

App 第一次打开时只显示一个安装进度页，没有选项。普通用户不需要知道 launchd、Node 这些词。

```
┌──────────────────────────────────────────┐
│  Paimon                                  │  ← 窗口标题：Lead 名字（这时还读不到配置，用缺省名）
│                                          │
│  正在准备 Bytezard Lead…                  │
│  ✓ 复制程序文件                           │
│  ✓ 设置后台服务                           │
│  ◌ 启动服务（电脑忙时可能要几分钟）         │
│                                          │
└──────────────────────────────────────────┘
```

装好后窗口直接加载网关网页。Companion 先显示现有的 `FirstRunBrain`（接服务商、填 key、选模型），再显示新增的「选执行器」一步（第 5 节）。

窗口标题用用户配置的 Lead 名字（第 9 节决定 6）：

- Companion 网页把 `document.title` 设成 Lead 名字。Electron 的窗口标题缺省跟随网页标题，壳不另外处理。
- 安装页还没有网页可读。壳用上次记下的名字；第一次安装时用缺省名 `Paimon`（`packages/protocol/src/lead-profile.ts:14` 的 `DEFAULT_LEAD_NAME`）。
- Dock、菜单栏和「关于」里的 App 名是 Info.plist 里的 `Bytezard Lead`，不跟着 Lead 名字变。

### 4.2 步骤

壳只做第 1、2 步，其余由运行包里的 `ops.mjs desktop-install` 做，并按行输出 JSON 进度。这样安装逻辑在 Node 里，能写单元测试，`plc daemon install` 也能复用。

1. **移到应用程序文件夹。** 如果 `app.isInApplicationsFolder()` 返回 false，提示用户并调用 `app.moveToApplicationsFolder()`。Electron 文档写明移动成功后 App 会退出再重新打开（[Electron app API](https://www.electronjs.org/docs/latest/api/app)）。
2. **解出运行包。** 把 `Resources/runtime/bytezard-lead-runtime-<ver>-arm64.tar.gz` 解到 `versions/<ver>.partial/`，校验 `release.json.files`，再 `rename` 成 `versions/<ver>/`。去掉 `com.apple.quarantine` 扩展属性（`xattr -dr com.apple.quarantine <目录>`，参数固定，用 `execFile` 不经 shell）。然后原子地切换 `current`。
3. **识别已有的安装，自动接管。** 改名以前的安装、跑开发 checkout 的安装、换了版本的安装，都自动接管，不要求用户做任何事（第 12 节，#234）。只有设了 `PLC_KEEP_DEV_INSTALL=1` 时，才保留开发安装、直接打开它（`dev_install_detected`，第 12.8 节）。
4. **采集登录 shell 的 PATH**（第 5.1 节），写进数据目录。
5. **装 plist。** 复用 `plistContent`/`installAgent`（`packages/supervisor/src/deploy/launchd.ts`），`nodeBin` 用 `current/bin/lead-agent`，`entry`、`cwd` 都用 `current` 的路径。用户级 LaunchAgent，`launchctl bootstrap gui/<uid>`，不需要 sudo。
6. **健康检查。** 等 `supervisor.sock` 能连上（60 秒），发 `ensure_running`，等 `plc.sock` 回答 `status`。等多久和 supervisor 一致：`DEFAULT_DAEMON_READY_TIMEOUT_MS`，2026-11-03 改成 10 分钟（59a8a29e），`ensure_running` 再多等 30 秒（`ensureRunningTimeoutMs`）。
7. **打开界面。** 从 `status.gatewayUrl` 拿地址。网关默认端口 47130，被占时会换端口（`apps/daemon/src/gateway-listen.ts:15,61`），所以不能写死端口。

发布模式下的 `desktop-install` 不检查 `AM_API_KEY`。现在的 `install()` 没有这个 key 就拒绝（`apps/daemon/src/ops.ts` 的 `install`），那是开发环境的要求。doctor 里 `AM_API_KEY` 和 aish 的检查在发布模式下改成「可选」（`ok: null`）。

### 4.3 失败时

每一步失败都写进 `install-state.json`（步骤、时间、错误码、给人看的一句话）。进度页显示：

- 一句话说哪一步没成功、为什么，例如「后台服务没能启动」。
- 「重试」按钮：从失败的那一步重新开始。每一步都是幂等的：`installAgent` 本来就是先 bootout 再 bootstrap。
- 「查看日志」：打开 `<数据目录>/logs/`。
- 「复制诊断信息」：运行 `ops.mjs doctor`，复制输出。doctor 不输出密钥。

已知的失败和提示：

| 现象 | 判断方法 | 给用户的话 |
|---|---|---|
| 用户在「登录项与扩展」里关掉了后台项目 | plist 在，`launchctl print` 显示未加载，bootstrap 报错（未核实具体错误码） | 打开「系统设置 → 通用 → 登录项与扩展」，把 Bytezard Lead 的后台项目打开，再点重试（列表里显示的名字以 P0-7 实测为准，可能是 `lead-agent`） |
| daemon 启动超过 10 分钟 | `startingDaemonVerdict` 是 `timed_out` | 服务启动得比平常慢，请稍等后点重试 |
| 磁盘满 | 解包或写文件报 `ENOSPC` | 磁盘空间不够，至少需要 1 GB |
| 端口全被占 | daemon 日志 | 附诊断信息 |
| socket 路径太长 | 数据目录下 `plc.sock` 的完整路径超过 104 字节 | 附诊断信息（用户名特别长时才会出现） |

macOS 13 以后，装 LaunchAgent 会弹「已添加后台项目」的系统通知。Apple 的说明里，这个开关在「系统设置 → 通用 → 登录项与扩展」（[Apple 支持：登录项与扩展](https://support.apple.com/guide/mac-help/change-login-items-extensions-settings-mtusr003/mac)）。进度页要提前说「接下来 macOS 会提示添加了后台项目，这是正常的」。这条通知和设置里显示的名字在 P0-7 实测（第 9 节决定 7）。

### 4.4 卸载

App 菜单「卸载 Bytezard Lead…」（P1）调用 `ops.mjs desktop-uninstall`：

1. bootout `com.bytezard.plc.supervisor` 和 `com.bytezard.plc.hindsight` 两个 launchd 任务，删掉两个 plist（复用 `uninstallAgent`、`uninstallHindsightService`）。
2. 删掉 `<数据目录>/runtime/` 和 `<数据目录>/shell/`。
3. 问用户要不要删数据。默认保留。选「同时删除我的数据」时删整个 `<数据目录>` 和 Hindsight 的嵌入式 Postgres 数据（`~/.pg0`）。删之前列出目录和大小，要用户确认。
4. 最后把 App 移到废纸篓，或者提示用户自己拖。

现有的 `plc daemon uninstall` 保留，行为不变。

## 5. runtime 探测（问题 4）

### 5.1 PATH 问题

从 Dock 打开的 App 和 launchd 启动的进程都拿不到用户 shell 里的 PATH，只有 `/usr/bin:/bin:/usr/sbin:/sbin`。用户用 nvm、Volta、npm 全局目录装的 `codex`、`claude` 就找不到。

结论：三层合起来用。

1. **已知目录**：`runtimeBinDirectories` 已经加了 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`（`packages/runtime/src/executable.ts:15-28`）。再补 `~/.npm-global/bin`、`~/.volta/bin`、`~/.bun/bin`、`~/.claude/local`，以及 `~/.nvm/versions/node/*/bin`（按版本号排序）。
2. **登录 shell 的 PATH**：安装时和每次打开 App 时，运行一次 `$SHELL -ilc 'printf "__PLC_PATH__%s__PLC_PATH__" "$PATH"'`，5 秒超时，只取两个标记之间的内容。命令是固定字符串，不拼接任何外部输入。`$SHELL` 只接受 `/etc/shells` 里列出的路径。结果写进 `<数据目录>/login-shell-path.json`。supervisor 和 daemon 启动时读它，合并进 `runtimeSearchPath`（`packages/supervisor/src/main.ts:9`）。
3. **手动指定**：现有的 `PLC_CODEX_BIN`、`PLC_CLAUDE_BIN`、`PLC_PI_BIN` 照旧生效。设置 → 执行器里加「指定路径」，写进 config.json（P2）。

### 5.2 「已安装」和「已登录」

现有探针已经分了这两层（`packages/runtime/src/probe.ts`、各 adapter 的 `probe`）：

| runtime | 已安装 | 已登录 |
|---|---|---|
| Codex | `locateExecutable` 找到，并且 `codex --version` 退出码 0 | `codex login status` 退出码 0（`codex.ts:141-147`） |
| Claude Code | `claude --version` 退出码 0 | `claude auth status --json` 的 `loggedIn` 为 true（`claude.ts:240-307`） |
| pi | 运行包自带，总是已安装 | `pi auth check --model <m> --json`（`pi.ts:232`） |

向导不新写探测，复用设置 → 执行器已有的数据和 `/v1/runtimes/recheck`（`packages/gateway/src/paired-server.ts:1776`）。

### 5.3 选执行器这一步

在 Companion 的首次启动引导里，`FirstRunBrain` 之后加一步 `FirstRunRuntimes`：

- 列出 Codex、Claude Code、pi 三项，每项显示「已安装 / 已登录 / 没找到」。
- 已安装的默认勾上。没找到的显示安装链接和「重新检测」。
- pi 总是可勾选，说明是「内置，用你刚才设置的模型服务」。
- 提交时把没勾的写进 `runtimes.disabled`，用现有的 `/v1/runtimes/settings` 和 UI 操作层（`packages/gateway/src/runtime-settings-routes.ts`）。这条操作已经同时有 HTTP 和 Lead 工具两个入口，符合 AGENTS.md 的「UI Actions」规则。
- 「跳过」等于全部保持默认。

### 5.4 pi 兜底怎样接进去

- pi 已经在 registry 里（`BUILTIN_ADAPTERS = [codex, claude, pi]`），运行包带着它，`locateExecutable` 能找到。用 daemon 自己的 Node 运行（`pi.ts` 的 `daemonNodeLaunch`）。
- 缺的一块：pi 用自己的 provider 配置（`~/.pi/agent/`），不是 Lead 在 `FirstRunBrain` 里配的那个。兜底要能直接用 Lead 的服务商和 key。方案：daemon 给 pi 执行器一个独立的 agent 目录（不碰用户自己的 `~/.pi`），在里面写入从 Lead 配置生成的 provider。pi 是否支持用环境变量指定 agent 目录，**未核实**，P1 工单第一步就是查 pi 1.1.0 的代码确认。
- 用户已有自己的 pi 配置时，优先用用户的。

## 6. Hindsight 放到后台装（问题 5）

- 桌面版**默认开启**记忆（第 9 节决定 4）。
- 向导不等 Hindsight。装好服务、打开界面就算完成。
- Hindsight 现在靠 PATH 上的 `uvx`，找不到就跳过（`packages/supervisor/src/deploy/hindsight.ts:258-265,374-376`）。普通用户没装 uv。结论：运行包带上 uv 的单文件二进制（astral 在 GitHub Releases 提供各平台的二进制，[uv 安装文档](https://docs.astral.sh/uv/getting-started/installation/)），`findUvx` 先找 `<root>/bin/uvx`。uv 默认会在需要时自动下载 Python（[uv：Installing Python](https://docs.astral.sh/uv/guides/install-python/)），所以不用另外装 Python。
- 模型下载（bge-m3 约 2.3 GB，`hindsight.ts` 头部注释）和 venv 由 daemon 现有的 `hindsight-models.ts` 流程在后台做。开始前检查剩余空间：≥ 6 GB 时开始下载；少于 6 GB 时不下载，在设置 → 记忆里说明原因。
- 进度显示在设置 → 记忆。下载中记忆功能不可用，其余功能照常。失败可以在那里重试。

## 7. 自动更新（问题 6）

### 7.1 Electron 的自动更新不能用

- Electron 文档：「Your application must be signed for automatic updates on macOS. This is a requirement of `Squirrel.Mac`.」（[Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)）
- electron-builder 文档：「macOS application must be signed in order for auto updating to work.」（[electron-builder Auto Update](https://www.electron.build/docs/features/auto-update)）
- Electron 的免费更新服务 update.electronjs.org 的条件里也有「Builds are code-signed (macOS only)」（[Electron：Updating Applications](https://www.electronjs.org/docs/latest/tutorial/updates)）。

所以没有 Apple 证书时，`autoUpdater` 和 `electron-updater` 都不用。

### 7.2 两层更新

| 层 | 多久变一次 | 怎样更新 | 阶段 |
|---|---|---|---|
| 运行包（daemon、Web、pi、Node） | 每次发版 | supervisor 下载、校验、换 `current`、重启 | P1 |
| App 壳（Electron） | 很少 | 只提示有新版，打开下载页 | P1 |
| App 壳自动替换 | — | 下载 zip、校验、替换 App、重开 | P2（第 9 节决定 2） |

大部分改动都在运行包里，壳只是安装器、窗口和通知出口，所以壳很少需要更新。

**2026-11-04 改成一键换整个 dmg（用户要求）。** 用户要的是：每天查一次 GitHub release，有新版时弹一个小提示，点「更新」就换成新版并重开，不能破坏以前的数据。所以先做了 App 壳的自动替换，更新的单位是整个 dmg，上表的运行包更新（第 7.3 节）还没做：

1. App 打开时距上次检查满 24 小时就查，开着时每小时看一次到没到。请求 `<仓库>/releases/latest/download/manifest.json`；仓库来自已装运行包的 `release.json.updateSource`。`release-macos.yml` 打出 dmg 以后，`scripts/desktop/add-dmg.ts` 把 dmg 的文件名、大小和 SHA-256 记进 `manifest.json`。
2. manifest 的版本比这份 App 新时，网页顶栏写新版本号和「更新」（主题 11.14 第 5 项）。「明天再提醒」：这个版本 24 小时内不再提示。
3. 点「更新」：下载 dmg（Electron 的 `net.fetch`，走系统代理），按大小和 SHA-256 校验；`hdiutil` 只读挂载，把里面的 App 用 `ditto` 复制到 App 所在目录下的隐藏暂存目录；核对版本号、bundle id，`codesign --verify`；卸载 dmg；两次 `rename` 换掉 App，第二次失败时把旧的挪回去；`app.relaunch()`。
4. 新 App 打开时照常跑第 4.2 节的流程：它带的运行包比装着的新，解包，`desktop-install` 按情况 C（第 12.5 节）先备份数据库、重启到新版本，失败自动回滚。数据目录不动。暂存目录和下载的 dmg 在新 App 打开时删掉。
   - 2026-11-05 补充：macOS 按 bundle id 找 App 的图标（通知、Dock）。换好 App 以后，把它的修改时间改成现在，再用 `lsregister -f` 重新登记它（ditto 保留打包时的时间，IconServices 会当它没变）。新 App 删暂存目录以前，先用 `lsregister -u` 去掉旧 App 的登记。起因：换了 App 图标以后通知还是 Electron 的图标，LaunchServices 里记着 17 份同一个 bundle id 的 App（删掉的暂存副本、别的工作区打出的 App、挂着的旧 dmg）。
5. App 菜单的「检查更新…」（用户 2026-11-05）：马上查一次，用对话框说结果。有新版时对话框给「更新」和「以后」，「更新」和网页里的是同一个动作；点过「明天再提醒」的版本也再提示。已经是最新版、查不了（没网）、不知道从哪里取更新时，各写一句。
6. 本机验证时用 `BYTEZARD_UPDATE_URL` 换掉 manifest 和 dmg 的地址（只收 https，或者 127.0.0.1、localhost 上的 http）。
7. 2026-11-10 补充：下载和替换出错后的处理。
   - 起因：一台 1.1.3 的 App 在 1.1.6 是最新版时查过一次，记下了 1.1.6。1.2.0 发布以后点「更新」，它请求 `releases/latest/download/bytezard-lead-1.1.6-arm64.dmg`。GitHub 把这个地址转到 v1.2.0 的 release，那里没有这个文件，所以回 404。重试不重新检查，所以每次都 404。
   - 下载地址固定到这个版本自己的 release：`releases/download/v<版本>/<文件>`。manifest 照旧从 `releases/latest/download/manifest.json` 取，旧 App 读的也是这个地址。
   - 点「更新」时，如果上次检查已经过了 10 分钟，先重新查一次 manifest，直接装最新的版本。下载回 404 时，也重新查一次。
   - 下载先写到 `<dmg>.partial`。断了以后带 `Range` 接着下；服务器不按 Range 回时，从头下。网络出错、卡住或者 5xx 时自动重试 3 次，间隔 2 s、5 s、15 s。下完以后再算整份文件的 SHA-256。App 重开时，还要装的版本的 `.partial` 留着。
   - 60 s 没收到数据就算卡住：中止这次请求，原因写 `stalled`。
   - 网页顶栏的失败提示后面接上原因的原文，例如 `HTTP 404`。
   - 每次更新先删掉以前留下的 `.bytezard-lead-update-*` 暂存目录，再用一个带随机后缀的新目录。删不掉的旧目录只记日志，不挡更新。删除时遇到 `ENOTEMPTY` 这类偶发错误会重试。

代码在 `desktop/src/updater.ts`；网页那一侧在 `apps/companion/src/state/shellUpdate.ts`。这个按钮调的是 App 壳，不是 daemon，所以 Lead 现在不能替用户点它（第 7.3 节的「检查更新」「更新」操作还没做）。

**2026-11-05 改成增量更新（用户要求），见第 7.5 节。** 更新的单位还是整个 dmg，但是没变的部分不再重写，只改了网页时不停服务，只留一份升级前的备份。

### 7.3 运行包的更新流程

1. **检查。** daemon 每 6 小时和每次启动时，请求 `https://github.com/<repo>/releases/latest/download/manifest.json`。GitHub 文档支持用 `/releases/latest/download/<文件名>` 直接下载最新 release 的附件（[GitHub：Linking to releases](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)）。这条路径不走 REST API，不受未认证请求每小时 60 次的限制（[GitHub REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)）。`<repo>` 来自 `release.json.updateSource`。
2. **提示。** 有新版本时，设置里显示「有新版本 1.4.0」和更新说明，Lead 也知道（通知走 Lead，和其他事件一样）。
3. **下载和预装。** 用户点「更新」或者 Lead 自己决定更新时，下载 `bytezard-lead-runtime-<ver>-arm64.tar.gz`，按 `manifest.json` 的 SHA-256 校验，解到 `versions/<ver>.partial/`，校验 `release.json.files`，再 rename。然后跑一次 `versions/<ver>/bin/lead-agent .../ops.mjs selfcheck`：能加载 better-sqlite3，能读 release.json。这一步不停服务。
4. **切换。** 发 `request_maintenance{action:"upgrade", targetVersion:"1.4.0"}`。supervisor 沿用现有的维护流程（`server.ts` 的 `executeMaintenance`）：等 Lead 和执行器排空 → 在线备份数据库 → 停 daemon → **原子地把 `current` 换到新版本** → 用新版本启动 daemon → 校验 schema 和健康。
5. **supervisor 自己换代。** daemon 健康后，supervisor 正常退出，launchd 的 KeepAlive 从 `current` 拉起新版本的 supervisor。
6. **回滚。** 第 4 步校验失败时，把 `current` 换回旧版本，用旧版本启动 daemon。如果新版本已经迁移了库（schema 变大），旧代码打不开，就用第 4 步的备份恢复库再启动。失败原因记进维护记录，并通知用户。
7. **事后告诉用户。** Lead 自己触发的更新，结束后系统告诉用户：从哪个版本到哪个版本、成功还是已回滚、原因（第 9 节决定 3）。

要改的地方：

- `MaintenanceRequest` 加 `targetVersion`（`packages/protocol/src/local-sockets.ts`）。这是 supervisor.sock 的线上契约，要和 plc 一起改。
- supervisor 的 `daemonCommand` 现在在启动时算一次（`main.ts` 的 `daemonCommand()`），要改成每次 spawn 前从 `current` 重新解析。
- 「检查更新」和「更新」是两个 UI 操作，各有 HTTP 路由和 Lead 工具，走 `packages/engine/src/ui-actions/`。两个都声明为 `lead_allowed`、`changesRules: false`：更新不是改规则，按 AGENTS.md 的「UI Actions」，Lead 在任何回合都能做。这和现有的 `request_runtime_maintenance`（Lead 能请求重启）一致。不另加外部回合的限制；要加的话先问用户。

### 7.4 完整性和来源

- P1 下载走 HTTPS，校验 SHA-256（第 9 节决定 5）。`manifest.json` 和运行包来自同一个 release，所以哈希只能发现损坏，不能证明来源。这和用户手动下载 dmg 的信任程度相同。
- P2 再加签名：CI 用 Ed25519 私钥给 `manifest.json` 签名，公钥打进 App。私钥放进 GitHub Actions 的 secret。好处是仓库附件被换掉时，App 能发现；代价是多管一把密钥，丢了要发新版换公钥。
- 用 Node 下载的文件不会带 `com.apple.quarantine` 属性，所以换运行包不会再触发 Gatekeeper。**未在干净机器上实测**，P1 验收要测。

### 7.5 增量更新（2026-11-05）

用户 2026-11-05 要求：更新时没变的部分不重写；只改了网页时不停服务；只在服务的代码或者库的 schema 变了时才停服务；只在需要时备份，并且只留一份备份。这一节写下做法。

一键更新（第 7.2 节）在真的 App 上实测（2026-11-05，两个本机构建之间）：

| 项 | 实测 |
|---|---|
| 解包（「复制程序文件」一行） | 约 113 秒 |
| 接管（停服务、换版本、启动） | 14 秒 |
| 其余步骤 | 约 11 秒 |
| 一个版本的运行包 | 17,169 个文件，412 MB |
| 和上一个版本逐字节相同的部分 | `node_modules`（17,071 个文件，208 MB）、`bin/lead-agent`（116 MB） |
| `apps/` | 94 个文件，88 MB，其中 6 个源码映射文件占 54 MB |
| `<数据目录>/backups/` | 5.7 GB，每次升级多一份约 230 MB 的 `pre-upgrade-<时间>.db` |

同一台机器上又量了几种复用的办法：

| 办法 | 耗时 |
|---|---|
| 解出运行包里 `node_modules` 和 `bin/lead-agent` 以外的部分 | 0.9 秒 |
| 用 APFS 克隆逐个复制 `node_modules`（`cp -cR`，18,685 项） | 11.4 秒 |
| 用硬链接逐个复制 `node_modules`（`pax -rwl`） | 7.5 秒 |
| 用 APFS 克隆复制 `bin/lead-agent`（`cp -c`） | 0.005 秒 |

文件多时，每建一个文件都慢（这台机器装了安全软件）。所以 `node_modules` 不再逐个复制，改成各个版本共用一份。

#### 7.5.1 运行包的五个组成

打包脚本（`scripts/desktop/lib/release.ts` 的 `componentOf`）把运行包里的每个文件归到一个组成，给每个组成算一个内容哈希，写进 `release.json` 和 `manifest.json` 的 `components`。哈希按「路径、文件或软链接、可执行位、内容的 SHA-256 或软链接的目标」排好序再算，不含时间。

| 组成 | 包括 | 变了以后 |
|---|---|---|
| `node` | `bin/lead-agent`、`bin/node`、`bin/Bytezard Lead` | 重启服务 |
| `node_modules` | `node_modules/` 下的全部 | 重启服务 |
| `service` | `apps/daemon/` 下除了 `dist/web/` 的全部、根目录的 `package.json` | 重启服务 |
| `web` | `apps/daemon/dist/web/` | 不重启 |
| `cli` | `apps/cli/`、`bin/plc` | 不重启 |

- 有文件不属于任何组成时，打包失败。以后往运行包里加东西（例如 uv），要先决定它属于哪个组成。
- 哈希直接按内容算，所以 Node 版本（`desktop/node-version`）、架构、依赖变了，`node` 或 `node_modules` 的哈希都跟着变，不只看根目录的 lockfile。
- `release.json.schemaVersion` 照旧，库的 schema 单独比较。
- 旧的 `release.json` 没有 `components`。这时按「服务变了」处理：重启，备份。

#### 7.5.2 更新的种类

`desktop-install` 发现换了版本（第 12.5 节，情况 C）以后，拿上次装好的版本（`versions/<旧版本>/release.json`）和这次的比，得出更新的种类（`packages/supervisor/src/deploy/update-kind.ts`）：

| 种类 | 怎样判断 | 停服务 | 备份 | 安装页 |
|---|---|---|---|---|
| `none` | 五个组成和 `schemaVersion` 都一样（只换了 App 壳） | 不停 | 不备份 | 没有「备份数据，换到新版本」一行 |
| `web` | 只有 `web`、`cli` 变了 | 不停 | 不备份 | 同上 |
| `service` | `node`、`node_modules`、`service` 有一个变了，`schemaVersion` 一样 | 排空后停，重启 | 在线备份 | 「备份数据，换到新版本」 |
| `schema` | `schemaVersion` 变了 | 排空后停，重启 | 停服务以后备份（必须） | 同上 |

- 不停服务的种类还要满足一条：库的 schema 版本等于新版本的 `schemaVersion`。不满足时按 `service` 处理。
- 停的只有服务的进程（supervisor、daemon）。执行器在 daemon 重启以后由新的 daemon 接管，不停。
- 不重启时，服务还跑在旧版本的目录上。`install-state.json` 记下服务跑在哪个版本（`serviceVersion`），删旧版本时留着它。
- 安装页原来对普通升级也显示「接手已有的数据和设置」，用户读成要搬数据。现在只有情况 A、B 显示这一行；情况 C 要重启时显示「备份数据，换到新版本」，不重启时不显示。`detect` 一步的进度行带上 `takeover`（`pre_rename`、`dev`、`upgrade`）和 `update`（上表的种类），壳按它选这一行的文字。

#### 7.5.3 网页从 current 提供，由 daemon 自己核对

原来 daemon 从自己所在的版本目录提供网页（`defaultWebRoot()` 是 `versions/<版本>/apps/daemon/dist/web`）。只换 `current` 时，在跑的 daemon 照旧给旧网页。

现在发布模式下，daemon 每次提供网页前（结果缓存 2 秒）看 `<安装根>/current/release.json`：

- `current` 的 `node`、`node_modules`、`service` 和 `schemaVersion` 都和 daemon 自己的一样：用 `current` 的网页。这时新网页和在跑的 daemon 出自同样的服务代码，所以新网页不需要更新的 daemon。
- 不一样，或者有一边没有 `components`：用 daemon 自己的网页。所以换版本到重启之间（排空最长 30 分钟），旧 daemon 不会给出要新 daemon 的网页。

网页的版本提示（`apps/companion/src/state/webVersion.ts`）读 `/web-build.json`，它也来自 `current`，所以已经打开的页面会提示「有新版本，刷新」。

#### 7.5.4 解包时复用没变的部分

壳解包（`desktop/src/runtime-bundle.ts`）时先只读出压缩包里的 `release.json`（打包时把它放在压缩包的第一项），再按 `components` 决定：

- `node_modules`：放在 `<安装根>/shared/node_modules/<哈希>/node_modules/`，版本目录里的 `node_modules` 是指向它的相对软链接。共享目录里已经有这个哈希时只建软链接。没有、但别的版本目录里有同样哈希的真目录（例如旧版 App 在后台整个解出的版本，第 7.5.6 节）时，用 APFS 克隆复制一份进去。都没有时，从压缩包只解出 `node_modules`，先解到 `<哈希>.partial`，再 rename。
- `bin/lead-agent`：别的版本的 `node` 哈希一样时，用 APFS 克隆复制（`COPYFILE_FICLONE`，不是 APFS 时退回普通复制），不从压缩包解。
- 其余的从压缩包解出，跳过上面两项。然后照旧核对 `release.json.files`（经过软链接也核对 better-sqlite3 的原生模块），去掉 quarantine，rename，换 `current`。

共享目录里的项装好后不再改。版本目录照旧各自完整：回滚到上一个版本时，它的软链接指的那一份还在。共用一份 `node_modules` 不影响模块解析：Node 解开软链接以后，包和包之间在同一个 `node_modules` 里互相找到。`desktop-install` 删完旧版本以后，删掉共享目录里没有版本目录再指向的项。

目标是只改了网页或服务代码时，解包在几秒内完成。依赖变了时，`node_modules` 照旧要整个解出来。旧格式的压缩包（没有 `components`）照旧整个解。

#### 7.5.5 只留一份升级前的备份

- 情况 C 的备份只写一个文件：`<数据目录>/backups/pre-upgrade.db`。先写到 `pre-upgrade.db.partial`，用 `PRAGMA integrity_check` 核对，结果是 `ok` 才 rename 覆盖旧的一份。没核对过以前不删旧的。核对不过时删掉临时文件，这次升级停在停服务以前，什么都不改。
- `service`：排空以前在线备份（服务还在跑）。
- `schema`：停服务以后备份。这时没有进程在写库，这一份就是升级前的原样，回滚用它恢复库。不再另做在线备份，也不再写 `-stopped.db`。
- 新的一份放好以后，删掉以前按时间命名的升级备份：`pre-upgrade-<时间>.db`、`pre-upgrade-<时间>-stopped.db`、`pre-upgrade-<时间>.supervisor.plist`。别的备份都不动：`pre-takeover-*`、`pre-rename-*`、supervisor 维护时的 `plc-pre-*`、手动做的备份。
- 情况 C 不再复制 supervisor 的 plist：它的内容没变。情况 B 照旧复制（开发者要回到开发安装时参考）。
- 不停服务的种类（`none`、`web`）不备份。

#### 7.5.6 在后台先解好新的运行包

点「更新」以后，壳下载、校验 dmg，把新 App 复制到暂存目录。现在多一步：换掉 App 以前，从暂存的新 App 里取出运行包，解到 `versions/<新版本>/`，不换 `current`。这一步失败不挡更新，新 App 打开时自己再解。新 App 打开时看到这个版本已经解好、文件完整，就只换 `current`。用户等的只有重开和切换。

这一步由正在跑的旧 App 做，所以从带这个改动的 App 开始的下一次更新才用上。

#### 7.5.7 源码映射不进运行包

`apps/daemon/dist/*.map` 和 `apps/cli/dist/*.map` 不再放进运行包（约 54 MB）。运行时没有用到它们：没有进程开 `--enable-source-maps`。打包脚本把它们另打成 `bytezard-lead-sourcemaps-<版本>-arm64.tar.gz`，作为 release 的附件，查问题时下载。

#### 7.5.8 实测（改动以后，2026-11-05）

在同一台机器上打了三个运行包：A 是这个改动本身；B 只多了一个空提交（网页的版本号不同）；C 改了 daemon 的一句用法说明。三次构建的 `node`、`node_modules`、`cli` 哈希都一样；B 只有 `web` 变了，C 的 `service` 和 `web` 变了。所以本机重新构建是确定的，A→B 是 `web` 更新，B→C 是 `service` 更新。

解包都在隔离的临时数据目录里做（不碰装着的 App）：

| 解包 | 改动以前 | 改动以后 |
|---|---|---|
| 第一次装（共享目录是空的） | 93 秒 | 107–144 秒（多读一次压缩包；时间随磁盘忙闲变） |
| A→B，只改了网页 | 103 秒 | 1.1–1.4 秒 |
| B→C，服务变了 | 没量（同样整个解） | 1.5 秒 |

- 压缩包从 100.7 MB 变成 88.9 MB，运行包目录从 412 MB 变成 380 MB。源码映射另打成 11.9 MB 的附件。
- 隔离的数据目录里（临时 HOME、假 `launchctl`，和冒烟脚本一样）从 A 启动 supervisor 和 daemon，再用壳的解包换 `current`：换到 B 以后，同一个 daemon 进程（pid 不变）给出 B 的网页（`/web-build.json` 是 B 的版本号）；换到 C 以后，它给回自己 A 的网页，因为 C 的服务和它不一样。
- 备份：243 MB 的库，复制加 `integrity_check` 一共 1.1 秒，只留一个文件。
- 停服务、换版本的那一段（接管，14 秒）和以前一样，没有量。不重启的更新不经过这一段。

用户同意以后，在真的 App 上做了一次端到端（2026-11-05）。三个包的版本号改成 `1.1.2-local.*`，排在装着的 1.1.1 之后；更新的入口是网页的「更新」：

| 更新 | 从点「更新」到窗口打开 | 其中 |
|---|---|---|
| 1.1.1 → A（`service`，共享目录第一次建） | 1 分 56 秒 | 下载和换 App 6 秒，解包 72 秒，desktop-install 32 秒（排空、备份、重启） |
| A → B（`web`） | 27 秒 | 旧 App 在后台解好新版本 1.1 秒，新 App 解包 0.35 秒（直接用），desktop-install 15 秒，其中 12 秒在删 1.1.1 的整个目录 |
| B → C（`service`） | 28 秒 | 后台解包 1.1 秒，新 App 解包 0.33 秒，接管 12 秒（排空、备份、停服务、启动、健康检查） |

- A→B：daemon 的进程号不变，没有新的备份，安装页没有「备份数据，换到新版本」一行，网页是 B 的版本。
- 1.1.1→A：只留一个 `pre-upgrade.db`（252 MB），删掉了 14 个以前按时间存的升级备份文件，`backups/` 从 6.31 GB 变成 4.87 GB。
- B→C：daemon 重启了，`pre-upgrade.db` 换成了新的一份，还是只有一份；A 被删掉（服务换到了 C）。
- 删旧版本时，这个改动以前解出的版本里是真的 `node_modules`，删它要十几秒；以后的版本只有软链接，删得快。

#### 7.5.9 没做的和没核实的

- 只下载运行包（App 壳没变时不下载整个 dmg，第 7.3 节）：还没做。`manifest.json.components` 已经有了，以后按它判断。
- CI 上每次构建的 `better_sqlite3.node`、`bin/lead-agent`（重签以后）是不是逐字节一样：没核实。本机两次构建是一样的。不一样时只是多重启一次、多解一次 `node_modules`，不会出错。
- 这个改动以后的第一次更新，共享目录还是空的：上一个版本没有 `components`，所以 `node_modules` 还要整个解一次，服务照旧重启。

## 8. GitHub Actions、Gatekeeper、命名和通知（问题 7、8）

### 8.1 workflow 设计

文件：`.github/workflows/release-macos.yml`。进 master 以后，随下一次快照公开。

```yaml
name: release-macos
on:
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      tag: { description: "要打包的 release tag", required: true }
permissions:
  contents: write          # 往 release 上传附件
concurrency:
  group: release-macos-${{ github.event.release.tag_name || inputs.tag }}
  cancel-in-progress: false
jobs:
  build:
    runs-on: macos-15      # arm64
    env:
      TAG: ${{ github.event.release.tag_name || inputs.tag }}
      CSC_IDENTITY_AUTO_DISCOVERY: "false"
    steps:
      - uses: actions/checkout@<固定 SHA>
        with: { ref: "${{ env.TAG }}" }
      - uses: actions/setup-node@<固定 SHA>
        with: { node-version-file: desktop/node-version }   # 和运行包里的 Node 同一个版本
      - run: npm ci
      - run: npm run build && npm run build:web
      - run: node --import tsx scripts/desktop/pack-runtime.ts --arch arm64 --version "${TAG#v}" --repository "${{ github.repository }}"
      - run: node --import tsx scripts/desktop/smoke-runtime.ts out/runtime    # 冒烟测试：起一个临时数据目录的 daemon，等 status；失败时不上传
      - run: npm ci --prefix desktop && npm run --prefix desktop dist -- --mac dmg --arm64
      - run: gh release upload "$TAG" out/*.dmg out/*.tar.gz out/manifest.json --clobber
        env: { GH_TOKEN: "${{ github.token }}" }
```

逐条理由：

- **触发条件用 `release: published`，加 `workflow_dispatch` 用来重跑。** 仓库的 tag 受保护，只有仓库所有者能建 release，所以发版的动作就是所有者在 GitHub 上发布 release。GitHub 文档列出 release 事件的类型有 `published`、`created`、`prereleased` 等，并说明草稿 release 的 `created`、`edited`、`deleted` 不触发 workflow（[Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)）。注意：用 `GITHUB_TOKEN` 建的 release 不会触发新的 workflow，只有 `workflow_dispatch` 和 `repository_dispatch` 例外（[GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)）。所以 release 要由所有者本人发布，不能由别的 workflow 用默认 token 建。
- **`permissions: contents: write`。** 仓库默认的 Actions token 是只读的。GitHub 文档：「You can use `permissions` to modify the default permissions granted to the `GITHUB_TOKEN`」（[Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)）。只给这一个 workflow 写权限。fork 来的 PR 不触发 release 事件，不受影响。
- **只打 arm64，在 arm64 runner 上构建。** 用户 11-03 决定不出 Intel 版（第 9 节决定 1）。GitHub 托管的 macOS runner 里，`macos-15`、`macos-latest` 等是 arm64（[GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)）。electron-builder 文档建议在目标架构的硬件上构建（[electron-builder mac](https://www.electron.build/docs/mac)）。只有一个架构，所以不需要矩阵。清单文件也不带架构后缀，更新检查读的就是 `manifest.json`。
- **冒烟测试留在发版流程里。** 运行包打好后先在 runner 上真的起一次 daemon，失败时 job 失败，不上传附件。P1-6 再把同一个冒烟测试放到 PR 上跑。
- **原生模块。** 只有运行包里的 better-sqlite3 是原生模块，它跑在打包进去的 Node 上，不跑在 Electron 上。所以 CI 用和运行包同一个 Node 版本执行 `npm install`，装出来的就是对应 Node ABI 的 `.node` 文件，不需要 electron-rebuild。Electron 壳本身没有原生依赖，electron-builder 设 `npmRebuild: false`。打包脚本检查 `.node` 文件的架构是 arm64（`file` 或读 Mach-O 头）。
- **第三方 action 固定到 commit SHA**，不用 tag。
- **壳单独放在仓库根的 `desktop/`，有自己的 `package.json` 和 lockfile，不进根目录的 workspaces。** 根的 workspaces 是 `apps/*`，放进 `apps/` 会让每次 `npm ci` 都下载 Electron（约 100 MB），开发和测试都变慢。壳不 import 后端的包，它只和运行包通过 socket 和 `ops.mjs` 通信。

### 8.2 不签名时的配置

- electron-builder 设 `appId: com.bytezard.plc`、`productName: Bytezard Lead`、`mac.identity: "-"`（ad-hoc 签名）、`hardenedRuntime: false`、`notarize: false`，环境变量 `CSC_IDENTITY_AUTO_DISCOVERY=false`。electron-builder 文档：不签名时设 `CSC_IDENTITY_AUTO_DISCOVERY=false`；`identity` 设成 `"-"` 是 ad-hoc 签名；关掉签名时应该同时关掉 Hardened Runtime，否则 App 可能打不开（[code signing mac](https://www.electron.build/docs/features/code-signing/code-signing-mac)、[electron-builder mac](https://www.electron.build/docs/mac)）。
- 为什么用 ad-hoc 而不是完全不签：Apple Silicon 要求原生代码至少有一个签名，ad-hoc 签名就够。这一条来自 Apple 的开发者发行说明，我只找到了二手引述（[Eclectic Light](https://eclecticlight.co/2020/08/22/apple-silicon-macs-will-require-signed-code/)），**未找到 Apple 原文**。electron-builder 修改 App 包（改 Info.plist、换图标）以后，Electron 原有的签名会失效，所以要让它重新 ad-hoc 签一遍。
- 「ad-hoc 签名的 App 从网上下载后，在别的 Mac 上能否通过『仍要打开』正常启动」：**未实测**，P0-5 验收必须在一台没装过的 Mac 上测。
- ad-hoc 签名的 App 能不能发通知：2026-11-04 实测，用户授权后能发，见第 8.6 节。
- nodejs.org 的 Node 二进制本身有 Node 官方的签名（未逐项核实）；解出来以后去掉 quarantine 属性，launchd 运行时不再经过 Gatekeeper。

### 8.3 Gatekeeper 提示

用户第一次打开时，macOS 会拦住未公证的 App。Apple 官方的放行步骤是：先试着打开 App；然后打开「系统设置」，点「隐私与安全性」，向下滚动，点「仍要打开」；警告再出现时，确认打开（[Apple 支持 102445](https://support.apple.com/en-us/102445)）。放行一次后，以后双击就能打开。Apple 文档只写了系统设置这一条路，我们的文案也只写这一条。

三处文案。界面文字缺省英文，同时给中文（`docs/i18n.md`）。

**1. 下载页（release 说明模板 + README 的「安装」一节）**

> **Install Bytezard Lead**
> Bytezard Lead needs a Mac with Apple silicon.
> 1. Download `bytezard-lead-<version>-arm64.dmg`.
> 2. Open the dmg and drag **Bytezard Lead** to **Applications**.
> 3. Open Bytezard Lead. macOS says it cannot verify the developer. Click **Done**.
> 4. Open **System Settings → Privacy & Security**. Scroll down and click **Open Anyway**.
> 5. When the warning shows again, click **Open**.
>
> Bytezard Lead is not signed with an Apple certificate yet. You do these steps only once.

> **安装 Bytezard Lead**
> Bytezard Lead 需要 Apple 芯片的 Mac。
> 1. 下载 `bytezard-lead-<版本>-arm64.dmg`。
> 2. 打开 dmg，把 **Bytezard Lead** 拖到「应用程序」。
> 3. 打开 Bytezard Lead。macOS 提示无法验证开发者，点「完成」。
> 4. 打开「系统设置 → 隐私与安全性」，向下滚动，点「仍要打开」。
> 5. 警告再次出现时，点「打开」。
>
> Bytezard Lead 还没有 Apple 证书签名。这几步只需要做一次。

README 另加一节「打不开怎么办」，给高级用户：如果提示「已损坏」，在终端运行 `xattr -dr com.apple.quarantine "/Applications/Bytezard Lead.app"`。这一条不放在下载页正文里。

**2. dmg 背景图**

```
┌────────────────────────────────────────────────────┐
│                                                    │
│   [Bytezard Lead]    ───────▶     [Applications]   │
│                                                    │
│  First open: System Settings → Privacy & Security  │
│              → Open Anyway                          │
│  首次打开：系统设置 → 隐私与安全性 → 仍要打开         │
└────────────────────────────────────────────────────┘
```

背景图是一张图，所以中英文两行都放。尺寸和图标位置写在 electron-builder 的 `dmg.contents` 里。配色和字体按 `docs/design/themes/default.md`。

**3. App 首次打开后**

能看到 App 窗口，说明 Gatekeeper 已经放行。这时的提示针对后面两件事：

- App 不在「应用程序」里时：「把 Bytezard Lead 移到『应用程序』文件夹，这样它才能在后台一直运行。」按钮：「移动并重新打开」。
- 装后台服务之前：「接下来 macOS 会提示 Bytezard Lead 添加了后台项目。这是正常的：它让 Bytezard Lead 在你关掉窗口后继续工作。」

### 8.4 窗口安全

- `BrowserWindow` 只加载 `status.gatewayUrl`（回环地址）。`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- `will-navigate` 和 `setWindowOpenHandler`：同源才在窗口里打开；`https:` 链接交给系统浏览器（`shell.openExternal`）；其他协议拒绝。
- preload 只暴露几个只读值（App 版本、壳有没有新版），不暴露 Node 能力。

### 8.5 名字一览

| 东西 | 名字 | 谁定的 |
|---|---|---|
| 产品名、App 名（Info.plist 的 `CFBundleName`，electron-builder 的 `productName`） | `Bytezard Lead` | 用户，决定 6 |
| bundle id（electron-builder 的 `appId`） | `com.bytezard.plc` | 用户，决定 6 |
| supervisor 的 launchd label | `com.bytezard.plc.supervisor` | 用户，决定 6 |
| Hindsight 的 launchd label | `com.bytezard.plc.hindsight` | 按同一个前缀推出 |
| 后台进程名（Node 二进制改名） | `lead-agent` | 用户，决定 6 |
| 后台服务在「登录项与扩展」里的名字 | `Bytezard Lead`：plist 写软链接 `bin/Bytezard Lead`，指向 `bin/lead-agent`（ad-hoc 重签，标识 `com.bytezard.plc.agent`），第 8.7 节 | 用户 2026-11-04 13:35 定「登录项显示 Bytezard Lead」，做法 1b 由 Lead 选定 |
| 数据目录 | `~/Library/Application Support/Bytezard Lead/` | 用户，决定 6 |
| 安装根 | `<数据目录>/runtime/` | 本文，见第 2.2 节 |
| 发布附件 | `bytezard-lead-<版本>-arm64.dmg`、`bytezard-lead-runtime-<版本>-arm64.tar.gz`、`manifest.json` | 本文 |
| 通知来源 | 固定的 App 名 `Bytezard Lead` | 用户，决定 6 |
| 通知标题、窗口标题 | 用户配置的 Lead 名字，缺省 `Paimon` | 用户，决定 6、8 |

App 名写在 Info.plist 里。装好以后再改 Info.plist 会让签名失效，所以 App 名固定，不跟着用户的配置变。用户能改的名字只出现在通知标题和窗口标题里。

旧名字 `~/.pi-lead-child`、`com.pi-lead-child.supervisor`、`com.pi-lead-child.hindsight` 只在迁移代码和「旧 label」清单里保留（P0-8）。

**版本号和构建号（用户 2026-11-05）。** 关于窗口显示「版本 1.1.0 (202611050930)」：

- 版本号是 semver，来自 release 的 tag（`CFBundleShortVersionString`、package.json 的 `version`、运行包的 `release.json.version`）。npm、electron-builder、运行包的目录名和新旧比较都按 semver，所以不用四段的 `1.1.0.202611050930`；macOS 的版本号也最多三段。
- 构建号是 UTC 的年月日时分（`scripts/desktop/lib/release.ts` 的 `buildNumber`）。`release-macos.yml` 把它设成 `CFBundleVersion`（electron-builder 的 `buildVersion`），并和提交号一起写进 App 的 package.json 的 `buildInfo`。
- 关于窗口的说明一栏写提交号的前 7 位和后台服务（运行包）的版本（`desktop/src/build-info.ts`）。设置 → 设备 → 本设备显示同样几行，再加上网页的构建；「复制诊断信息」的开头也是这几行。
- 本机打的包排在最近一次发布之后、下一个补丁版本之前：`1.1.0` 之后是 `1.1.1-local.<构建号>`（`scripts/desktop/local-version.ts`）。时间一律用 UTC。
- 打包配置的文件名是 `desktop/desktop-builder.yml`（用户 2026-11-05 改名）。

### 8.6 通知

现状（P0-7 以后）：

- daemon 的桌面通知都经过 `DesktopNotifier`（`apps/daemon/src/desktop-notifier.ts`）。每条通知的标题是用户配置的 Lead 名字，每次发都重新读，用户改名后下一条就用新名字。
- App 开着、并且用户确认过这一份 App 的通知能显示时（见下面的「通知授权」，#232），壳（`desktop/src/notifications.ts`）在 `plc.sock` 上发 `subscribe_desktop_notifications`，带数据目录里 `shell-pairing.key` 的口令。执行器的沙箱读不到这个文件，所以别的进程订不走通知。
- 有订阅时，daemon 把每条通知写成一行 `desktop_notification` 推给壳，不调 osascript。壳用 Electron 的 `Notification` 发出，同一条通知只弹一次。用户点通知时，壳把窗口提到前面。
- App 关掉时连接断开，就是退订。daemon 改回自己用 osascript 发，标题也是 Lead 名字。正文和标题作为 osascript 的参数传进去，不拼进 AppleScript 源码。
- Electron 发某一条失败（`failed` 事件）时，壳用 `desktop_notification_failed` 把正文交回 daemon，daemon 用 osascript 补发这一条。壳随后退订，这次运行里以后的通知都由 daemon 发，并且忘掉确认记录，下次打开 App 时重新检查。
- `PLC_DESKTOP_NOTIFY=off` 时 daemon 既不调 osascript，也不推给壳。根 vitest 配置设置了它，测试不在桌面上弹通知。

通知授权（#232，2026-11-04）：

- Electron 45 在 macOS 上用 `UNUserNotificationCenter` 发通知。它在建通知的 presenter 时调一次 `requestAuthorizationWithOptions`（alert、sound、badge），结果只在设了 `ELECTRON_DEBUG_NOTIFICATIONS` 时写日志，不读授权状态，也不告诉 JS（[notification_presenter_mac.mm](https://github.com/electron/electron/blob/v45.2.1/shell/browser/notifications/mac/notification_presenter_mac.mm)）。`Notification.isSupported()` 和 `new Notification()` 都会建 presenter（[electron_api_notification.cc](https://github.com/electron/electron/blob/v45.2.1/shell/browser/api/electron_api_notification.cc)）。壳在 App 就绪时调 `isSupported()`，所以第一次打开 App 时 macOS 弹权限卡。
- `show` 事件是 `addNotificationRequest` 成功的回调，`failed` 是它报错的回调（[cocoa_notification.mm](https://github.com/electron/electron/blob/v45.2.1/shell/browser/notifications/mac/cocoa_notification.mm)）。Apple 的说明：App 没有授权时提交通知请求，报 `UNError.Code.notificationsNotAllowed`（[Apple：notificationsNotAllowed](https://developer.apple.com/documentation/usernotifications/unerror/code/notificationsnotallowed)）。但实测 1 第一轮和实测 5 都是：只有 `show`，系统不显示。所以 `show` 不说明通知显示了。
- Apple 要求发通知前先申请授权，第一次申请时系统问用户，以后再申请不再问；用户随时能在系统设置里改，App 要用 `getNotificationSettings` 读当前状态（[Apple：Asking permission to use notifications](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications)、[requestAuthorization](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/requestauthorization(options:completionhandler:))）。Electron 没有暴露 `getNotificationSettings`；Electron 的通知文档推荐的 `macos-notification-state` 是原生模块（[Electron：Notifications](https://github.com/electron/electron/blob/v45.2.1/docs/tutorial/notifications.md)），壳不带原生依赖（第 8.1 节）。
- 本机核实：macOS 27.2 上 `~/Library/Preferences/com.apple.ncprefs.plist` 最后一次写入是 2025-09-16（macOS 26 发布前后），`defaults export com.apple.ncprefs` 也没有 2025-09 以后装的 App。所以实测 5 里「`ncprefs` 没有 `com.bytezard.plc`」不能说明 App 没有授权记录。新的存放位置在 `group.com.apple.usernoted` 的组容器里，执行器的沙箱读不到。

所以壳的做法是「用户亲眼确认」（`desktop/src/notification-check.ts`）：

- 壳记下用户确认过通知能显示（`<数据目录>/shell/notification-check.json`）。确认只按 App 记，不按构建：实测 6 换了构建、签名摘要变了以后，系统的授权还在，通知照常显示。所以更新 App 以后不再问（2026-11-05，用户问「为什么每次重新安装或者升级都要显示」）。记录里仍写着确认时那一份 App 的标识（`Contents/_CodeSignature/CodeResources` 的 sha256；开发时用版本号），诊断用。
- 没确认时壳不订阅，通知由 daemon 用 osascript 发，进通知中心，发送者显示为脚本编辑器。这是「show 了却没授权」的兜底：通知不丢。
- 装好服务、打开 Companion 以前，安装页多一屏「打开通知」：请用户在权限卡上点「允许」，再发一条测试通知。用户点「看到了」或者点了那条测试通知，壳记下这一份 App，开始订阅。用户点「没看到」，或者 Electron 报 `failed`，安装页说明去「系统设置 → 通知 → Bytezard Lead」打开「允许通知」，并给出「打开系统设置」按钮（`x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.bytezard.plc`）。点「以后再说」直接打开 Companion，下次打开 App 再问。
- 确认以后系统设置里又关掉了通知：按 Apple 的说明，Electron 会报 `failed`，走上面的补发和退订。这一条要实测 6 核实（[p0-7-measurements.md](p0-7-measurements.md)）；换构建以后授权还在，实测 6 已经核实。
- 截图：`artifacts/ticket-232-notification-check/`。

目标（第 9 节决定 6）：

- 通知中心里的来源显示 `Bytezard Lead`。
- 每条通知的标题是用户配置的 Lead 名字。
- 正文是通知内容。

风险：Electron 的通知文档原文是「For notifications on macOS, your application will need to be code-signed in order for notification events to emit correctly. … Unsigned binaries will emit a `failed` event when notification APIs are called.」（[Electron：Notifications](https://github.com/electron/electron/blob/main/docs/tutorial/notifications.md)）。文档没写 ad-hoc 签名算不算已签名。P0-7 实测。

**选择（定稿）：路径 A。** 主人 2026-11-04 17:24 选了方案 B：「既然都走 electron 打包 App 了，肯定走标准方案」。所以保留路径 A，App 开着时由 Electron 发通知；实测 5 里 Electron 通知不进通知中心的问题，放到 P0-8 之后另开工单处理，P0-7 不改代码。实测在 macOS 27.2（26B123）的 Apple 芯片 Mac 上做，步骤和记录见 [p0-7-measurements.md](p0-7-measurements.md)。PLC 执行器的沙箱里做不了这些实测。

为什么选 A：

- ad-hoc 签名的 App 在用户授权以后，能用 Electron 的 `Notification` 发出通知。probe 收到 `show` 事件，没有 `failed`。
- 权限卡上的名字和「系统设置 → 通知」里的名字都是 `Bytezard Lead`。系统把 App 当成一个独立的通知来源，所以能达到决定 6 的「来源显示 App 名」。
- 实测 5 里 Electron 通知没有进通知中心（见下面的已知限制）。它不改变路径的选择：B1 的来源是脚本编辑器的图标，做不到决定 6；B2 未核实。
- 不需要 B2：B2 只在 ad-hoc 签名的 Electron 发不了通知时才有意义。

已知限制：

- 用户点「允许」之前，App 发的通知会被系统收下（Electron 报 `show`），但不显示，也没有 `failed`。第一轮实测就是这样。#232 以后，用户确认以前壳不订阅，这段时间的通知由 daemon 发，不再丢。
- 权限卡上用的是缺省的 Electron 图标：打包时没设 App 图标（构建日志写着 `default Electron icon is used`）。这属于 P0-4、P0-5 的打包问题。
- Electron 通知收到 `show`，却不进通知中心（实测 5，2026-11-04 17:13）：#232 用上面的「用户亲眼确认」兜住，确认以前通知由 daemon 发。实测 5 的 App 为什么没有显示，还没查清：`ncprefs` 已经不再写入，不能当证据。实测 6 用 `ELECTRON_DEBUG_NOTIFICATIONS` 读授权申请的结果。
- App 关着时，daemon 用 osascript 发的通知进通知中心，标题是 Lead 名字，图标是脚本编辑器的通用图标，没有单独的 App 名，不是 Bytezard Lead（实测 5，主人 17:19 截图）。实测 2 时横幅弹出过；实测 5 时横幅没有弹出，原因没查（可能是专注模式，或者脚本编辑器的提醒样式）。这是路径 A 里 B1 那一半的已知缺点，第 9 节最后一段「还没定的一件事」就是在问它。

路径 A（已实现）：

- App 在运行时，壳的主进程通过 `plc.sock` 订阅 daemon 的桌面通知，用 Electron 的 `Notification` 发出。标题是 Lead 名字。
- 有壳订阅时，daemon 不再调 osascript，避免同一条通知弹两次。
- App 没在运行时，daemon 照旧用 osascript，标题是 Lead 名字。
- Electron 报 `failed` 时，壳把这一条交回 daemon 用 osascript 补发，然后退订。实测里没有出现 `failed`，这是保险。

没选的备选：

- **B1：一直用 daemon 的 osascript。** 已经包含在路径 A 里：App 不在、或者 Electron 发失败时就是 B1。实测：图标是通用的脚本图标，做不到决定 6 的「来源显示 App 名」。
- **B2：App 包里带一个原生通知助手。** 一个很小的 Swift 程序，用 `UNUserNotificationCenter` 发通知，daemon 调它。实测证明 ad-hoc 签名的 Electron 已经能发，B2 没有必要。它能不能在 App 关着时以 App 的名义发通知，**未核实**；如果用户想让 App 关着时的通知也显示 Bytezard Lead，可以再评估它。

### 8.7 登录项显示的名字

实测（2026-11-04，macOS 27.2）：用 `lead-agent` 启动的 LaunchAgent 装好后，「系统设置 → 通用 → 登录项与扩展 → 允许在后台」里显示的是 **Node.js Foundation**（Running in background），图标是通用占位图，不是 `lead-agent`，也不是 `Bytezard Lead`。没有弹出「已添加后台项目」通知。卸掉探测服务以后「Node.js Foundation」还在：开发机上原有的 supervisor 和 hindsight 也用 Node 运行，macOS 把用 Node 官方签名的后台项目合在一起，显示成开发者名。

原因：`lead-agent` 只是 Node 的改名副本，签名还是 Node 官方的（`Identifier=node`，`TeamIdentifier=HX7739G8FX`）。Eclectic Light 的文章写明「The Developer Name given is taken from the code signing certificate」（[Manage login and background items](https://eclecticlight.co/2025/12/03/manage-login-and-background-items/)）。所以第 9 节决定 7 只靠改名做不到。

**用户 2026-11-04 13:35 定：登录项要显示成 Bytezard Lead，不能显示成 Node.js Foundation，现在就改，放进 P0-7。**

三个方向的评估：

| 方向 | 做法 | 资料怎么说 | 改动 |
|---|---|---|---|
| a. 后台程序用自己的签名 | 把 Node 放进运行包里的 `Bytezard Lead.app` 程序包（`CFBundleName`、`CFBundleDisplayName` 是 Bytezard Lead，`CFBundleIdentifier` 是 `com.bytezard.plc.agent`），用 `codesign --force --sign - --identifier com.bytezard.plc.agent` 重新做 ad-hoc 签名，去掉 Node 的 Team ID | Apple 没写没有 Team ID 的程序显示什么名字。2026-11-04 实测 3：不再归到「Node.js Foundation」下面，但设置页显示的是**可执行文件名 `lead-agent`**，不是 Bytezard Lead | 小：只改打包脚本和 plist 里程序的路径；`bin/lead-agent` 改成指向程序包里的软链接，别的调用方不变 |
| b. 用 `SMAppService.agent` 从 App 注册 | plist 放进 `Bytezard Lead.app/Contents/Library/LaunchAgents/`，App 用 Electron 的 `app.setLoginItemSettings({ type: "agentService", serviceName })` 注册。Electron 文档：plist「must correspond to a property list in the app's `Contents/Library/LaunchAgents` directory」，并且「your app should be code signed and notarized for login item settings to work reliably」（[Electron app API](https://www.electronjs.org/docs/latest/api/app)）；Apple：这个框架「control helper executables that live inside an app's main bundle」（[Apple 部署指南](https://support.apple.com/guide/deployment/manage-login-items-background-tasks-mac-depdca572563/web)） | Electron 能调；但官方要求签名和公证，ad-hoc 下能不能注册，**未核实** | 大：程序要在 App 包里，和「运行包放在数据目录、单独更新」（第 2、7 节）冲突；App 被移走或删掉时服务失效；#204 的 `desktop-install` 和 supervisor 的 launchctl 流程都要改；开发机没有 App，用不了 |
| c. 只在 plist 加 `AssociatedBundleIdentifiers` | `launchd.plist` 加 `AssociatedBundleIdentifiers = com.bytezard.plc` | launchd.plist 手册：「indicates which bundles are associated with this job in the System Settings Login Items UI」。Apple 论坛上开发者报告加了以后「still continues to show our Developer Program name」，Apple 的工程师让他们提 bug（[Apple 论坛 713493](https://developer.apple.com/forums/thread/713493)）。2026-11-04 实测 3：ad-hoc 签名和 Node 官方签名下都**不起作用** | 最小：plist 加一个键 |

**定稿：做法 1b（2026-11-04，Lead 按主人 13:35「登录项显示 Bytezard Lead，现在就改」的决定选定；它不改第 9 节决定 6）。**

```
<运行包>/bin/lead-agent                    Node，ad-hoc 重签，标识 com.bytezard.plc.agent，没有 Team ID
<运行包>/bin/Bytezard Lead -> lead-agent   软链接；launchd 的 plist 写它
<运行包>/bin/node -> lead-agent
```

- 打包：`scripts/desktop/lib/agent-bundle.ts` 的 `installAgent`（`scripts/desktop/lib/pack.ts` 调它）。
- plist：`packages/supervisor/src/deploy/launchd.ts` 的 `desktopPlistOptions` 写 `<current>/bin/Bytezard Lead`，另加 `AssociatedBundleIdentifiers = com.bytezard.plc`。开发机的 plist 不变。
- 登录项显示软链接的名字 Bytezard Lead；进程名跟着真实文件走，还是 `lead-agent`。supervisor 用 `process.execPath` 拉起 daemon，Node 会解开软链接，所以 daemon 也叫 `lead-agent`。`bin/plc`、壳、冒烟脚本照旧用 `bin/lead-agent`。
- 交付的做法已经做了端到端实测（[p0-7-measurements.md](p0-7-measurements.md) 实测 5，探测项 p9，2026-11-04 17:13）：「允许在后台」列表显示 Bytezard Lead，不在「Node.js Foundation」下面；系统通知写「"Bytezard Lead" can run in the background」；进程名 `lead-agent`。

怎么得出来的（四次实测，记录见 [p0-7-measurements.md](p0-7-measurements.md)）：

1. 实测 2：只把 Node 改名为 `lead-agent`，签名还是 Node 官方的，后台项目归到「Node.js Foundation」下面。
2. 当时先选了 a 加 c：把 Node 放进 `Bytezard Lead.app` 程序包并重签（7335ec54）。
3. 实测 3（主人 15:57 的截图）：重签以后不再归到「Node.js Foundation」下面，但设置页显示的是可执行文件名 `lead-agent`。程序包的目录名、`CFBundleName`、`CFBundleDisplayName` 都不起作用；`AssociatedBundleIdentifiers` 在 ad-hoc 签名和 Node 官方签名下都不起作用（p2、p4）。`sfltool dumpbtm` 的 Name 和设置页不一致，不能当证据，之前根据它写的「方向 a 成立」是错的。
4. 实测 4（主人 16:55、Lead 16:56 的截图）：不在 `.app` 里的程序，设置页和「App Background Activity」通知显示 plist 里 `ProgramArguments[0]` 那个路径的文件名；是软链接时显示软链接自己的名字（p7、p8）。活动监视器的进程名（`ucomm`）跟着真实文件名走（p7、p8）。

| 实测 3、4 的探测项 | 做法 | 设置页「允许在后台」显示的名字（截图） | 进程名 ucomm |
|---|---|---|---|
| p1 | 程序包 + ad-hoc 重签 | `p1-exec`（程序名） | 没记录 |
| p2 | 同 p1，加 `AssociatedBundleIdentifiers` | `p2-exec` | 没记录 |
| p3 | 不放进程序包，只 ad-hoc 重签 | `p3-exec` | 没记录 |
| p4 | 保留 Node 官方签名，加 `AssociatedBundleIdentifiers` | 没有单独一行，推测合进了「Node.js Foundation」 | 没记录 |
| p5 | 实测 3 时交付的程序包做法 | `lead-agent` | `lead-agent` |
| p6 | 可执行文件叫 `Bytezard Lead P6` | `Bytezard Lead P6` | `Bytezard Lead P6` |
| p7 | plist 写软链接 `lead-agent-p7`，真实文件 `Bytezard Lead P7` | `lead-agent-p7`（带替身箭头） | `Bytezard Lead P7` |
| p8 | plist 写软链接 `Bytezard Lead P8`，真实文件 `lead-agent-p8` | `Bytezard Lead P8`（带替身箭头） | `lead-agent-p8` |

方案对比（要满足主人 13:35 的决定，又尽量不动第 9 节决定 6）：

| 做法 | 登录项 | 活动监视器的进程名 | 代价 |
|---|---|---|---|
| **1b（选定）**：plist 写软链接 `bin/Bytezard Lead`，真实文件 `bin/lead-agent` | Bytezard Lead（p8 实证） | `lead-agent`，和决定 6 一致 | 改了打包脚本和 plist（#203、#204 的代码）；`Bytezard Lead.app` 程序包已经去掉。活动监视器的「路径」一列显示软链接 `…/bin/Bytezard Lead`。设置页里这一项的图标带替身箭头 |
| 1a：真实文件就叫 `Bytezard Lead` | Bytezard Lead（p6 实证） | `Bytezard Lead`（p6），daemon 也一样 | 和决定 6 冲突。冒烟脚本按进程名 `lead-agent` 检查，要改；文件名带空格 |
| 1c：只有 supervisor 改名 | Bytezard Lead | supervisor 叫 Bytezard Lead，其余叫 `lead-agent` | 不需要：1b 不改 supervisor 的代码，也不违背决定 6 |
| 方向 b：`SMAppService` | 可能显示 App 名（未实测） | 不变 | 程序要放进 App 包，和运行包单独更新冲突；官方要求签名和公证；开发机没有 App |
| 接受显示 `lead-agent` | `lead-agent`（p5 实证） | `lead-agent` | 不满足主人 13:35 的决定 |

风险：

- ad-hoc 签名没有 Team ID。macOS 的隐私授权（例如访问「文稿」文件夹）对这种程序按签名的哈希记。每个运行包版本的哈希都不一样，所以运行包更新以后，用户给过的隐私授权可能要重新给。有 Apple 证书以后（P2-4）用 Developer ID 签名就没有这个问题。
- Hindsight 的后台项目（`com.bytezard.plc.hindsight`，P1-2）由 uv 启动，登录项里显示的是 uv 或 Python 的签名，不是 Bytezard Lead。P1-2 要用同样的办法处理，或者由 supervisor 拉起它、不单独注册。
  - 2026-11-05 实际情况：daemon 用 `[process.execPath, hindsight.mjs]` 写这个 plist，`process.execPath` 是解开软链接以后的 `versions/<版本>/bin/lead-agent`，所以「允许在后台」多了一项 `lead-agent`，图标是通用的 exec 图标（用户截图）。改法和 supervisor 一样：运行包多一个软链接 `bin/Bytezard Lead Memory -> lead-agent`，daemon 的 `hindsightProgram` 有这个软链接时写它（`apps/daemon/src/memory-backend.ts`），这一项显示 Bytezard Lead Memory。路径还是版本目录里的，换了服务代码时 plist 跟着变，Hindsight 跟着重启。
- 图标（用户 2026-11-05 实测）：给 `bin/lead-agent` 设一个访达里的自定义图标（App 的 `icon.icns`，用 `NSWorkspace setIcon:forFile:options:`）以后，「允许在后台」里的这几项显示 App 的水母图标；不设时是通用的 exec 图标。自定义图标写在文件的扩展属性里，不改文件内容，ad-hoc 签名照样对得上，程序照样能运行。所以壳每次解包或者直接用已经解好的版本时，都把自己的 `icon.icns` 设给 `versions/<版本>/bin/lead-agent`（`desktop/src/runtime-bundle.ts` 的 `setAgentIcon`，用 `osascript -l JavaScript`，路径从参数传）。设不上不算解包失败，结果记进 `<数据目录>/shell/install.log`。
- **用户 2026-11-05 定：Hindsight 不再单独注册后台任务，由 supervisor 拉起（「登录项与扩展」里少一行）。** 只留 Bytezard Lead.app 一行做不到：macOS 只在 App 自己用 `SMAppService` 注册、或者签名属于同一个开发者（有 Team ID）时，才把后台项目归到 App 名下（见上面方向 b、c）。所以先去掉记忆服务那一行，剩 Bytezard Lead 和 Bytezard Lead.app 两行；后者是 macOS 给 App 本身的记录，删不掉。做法：
  - daemon 照旧决定 Hindsight 的期望状态（`apps/daemon/src/memory-controller.ts`），只是不再写 launchd 的 plist，改写 `<数据目录>/hindsight/run.json`：程序、环境变量（没有密钥）和期望状态的指纹。关掉记忆时删掉这个文件。
  - supervisor 每 2 秒看一次 `run.json`（`packages/supervisor/src/hindsight-child.ts`）：有文件、没在跑时拉起；指纹变了时先停旧的再起新的；进程退出了，距上次启动满 30 秒再拉起（和原来 plist 的 `ThrottleInterval` 一样）；文件没了时停掉。supervisor 停机时一起停掉它。
  - 它还是 supervisor 的子进程，daemon 重启（Lead 请求的重启、崩溃）不碰它，和原来的独立任务一样。supervisor 重启时它跟着重启：换了服务代码的更新本来就会重启它（程序路径带版本号）。
  - 只有 daemon、没有 supervisor 时（开发时直接跑 daemon），没有人拉起 Hindsight，记忆不可用。
  - 已经装过的机器：新的 daemon 第一次写 `run.json` 时，bootout 旧的 `com.bytezard.plc.hindsight` 任务并删掉它的 plist。开发机上旧的 supervisor 不认识 `run.json`：要 `plc daemon install` 一次。
- 「已添加后台项目」通知在这台机器上一直没出现。这台机器装了 MDM 和安全软件，提示可能被压掉了。要在一台没装这些软件的 Mac 上再看一次。
- 探测时系统弹过两条以 `node` 署名的隐私提示：「"node" was prevented from modifying apps」和「"node" tried to access your data from other apps and was blocked」。探测脚本不读别的 App 的数据，也不改 App，所以触发者还没确认，可能是开发机上别的 node 进程（执行器在用户目录里工作）。改用自己的签名以后，正式版里这类提示的署名会是 `lead-agent` 或 Bytezard Lead，不再是 `node`（未实测）。要用 TCC 日志确认触发的进程路径。

## 9. 已定的决定

用户在 2026-11-03 16:42–16:47 定下这 11 条。每条写结论和本文改了哪里。

1. **只出 arm64，不打 x64。** 理由（用户）：苹果不再支持 Intel。第 8.1 节的 workflow 去掉矩阵，只在 `macos-15` 上构建；P1-6 只保留 CI 冒烟测试；下载页写明需要 Apple 芯片。
2. **App 壳只提示有新版本。** 自动替换放到 P2（P2-1）。第 7.2 节、P1-4。
3. **Lead 可以自己触发更新，事后告诉用户。** 「检查更新」「更新」两个操作都声明为 `lead_allowed`，不是改规则，Lead 在任何回合都能做。更新结束后系统告诉用户结果。第 7.3 节、P1-3。
4. **Hindsight 默认开启。** 剩余空间 ≥ 6 GB 时在后台下载模型，少于 6 GB 时不下载并说明原因。第 6 节、P1-2。
5. **更新清单的 Ed25519 签名放到 P2。** P1 先用 HTTPS 加 SHA-256。第 7.4 节、P2-2。
6. **命名。**
   - 产品名、App 名：`Bytezard Lead`。
   - bundle id（Electron appId）：`com.bytezard.plc`。
   - launchd label：`com.bytezard.plc.supervisor`。daemon 由 supervisor 拉起，不单独注册。
   - 后台进程名：把 Node 二进制复制一份，改名为 `lead-agent`。
   - 数据目录：`~/Library/Application Support/Bytezard Lead/`。
   - 通知：来源显示固定的 App 名；每条通知的标题用用户配置的 Lead 名字（缺省 `Paimon`），窗口标题也一样。App 名写在 Info.plist 里，装好后改了会破坏签名，所以不跟着用户配置变。

   全文已按这些名字改。名字一览见第 8.5 节，通知见第 8.6 节。
7. **改名一起解决「登录项显示 node」的问题。** 用户在开发机的「登录项」里看到的是 `node`。运行包里的 Node 改名为 `lead-agent`；开发机在迁移时也换成 Node 的改名副本（P0-8）。未签名的 LaunchAgent 在「登录项与扩展」里显示什么名字，要实测（P0-7）。
8. **默认 Lead 名保留 `Paimon`。** `DEFAULT_LEAD_NAME` 不改。
9. **`plc` 进 PATH 放到 P2。** 在设置里给一个开关，打开后建 `~/.local/bin/plc` 软链接（P2-3）。
10. **新增风险：未签名的 App 可能发不出通知。** Electron 文档原文和备选方案见第 8.6 节。ad-hoc 签名算不算已签名，在 P0 实测（P0-7）。不行就改成由 daemon 用系统方式发通知。
11. **新增 P0 迁移单，排在 P0 最后。** 开发机从 `~/.pi-lead-child`、`com.pi-lead-child.supervisor` 迁到新名字。迁移前在线备份数据库，旧的 plist 先 bootout，失败要能回滚（P0-8）。

还没定的一件事：App 关掉以后，通知走 daemon 的 osascript，来源不是 `Bytezard Lead`。要不要让壳在关掉窗口后留在后台（只在菜单栏，不显示窗口），专门做通知的出口？留在后台会在「登录项」里多一项。P0-7 实测以后，带着结果再问用户。

## 10. 实施工单

按依赖排序。每张工单都要按 AGENTS.md 先补测试。界面文字放进 `*.messages.ts`，带 `en` 和 `zh`。对外文案只用产品名 `Bytezard Lead` 和用户配置的 Lead 名字，不用内部代号。

```
P0-1 发布模式闸门 ──┐
P0-2 打包运行包 ────┴──▶ P0-3 desktop-install ──▶ P0-4 Electron 壳 ──┬──▶ P0-5 Actions + dmg + 安装说明
                                                                    └──▶ P0-7 通知和登录项的实测
P0-6 选执行器（只依赖现有接口，可以并行）

P0-1 … P0-7 全部合并 ──▶ P0-8 改名和开发机迁移（P0 最后一张）

P1-1 pi 用 Lead 的服务商   ← P0-2
P1-2 Hindsight 后台安装    ← P0-2
P1-3 运行包自动更新        ← P0-1, P0-3, P0-5
P1-4 壳的新版提示          ← P0-4, P0-5
P1-5 卸载                  ← P0-3, P0-4, P0-8
P1-6 PR 上的冒烟测试       ← P0-5
P2-*                       ← 对应的 P1
```

第一次对外发版要等 P0-8 合并。P0-8 之前，代码里的数据目录和 launchd label 还是旧名字。P0-1 到 P0-7 一律用常量（`dataDir()`、`LAUNCHD_LABEL`、`HINDSIGHT_LABEL`），不写死名字，这样 P0-8 改一处就全部生效。

### P0-1 部署闸门的发布模式

- 目标：有 `release.json` 时按版本、架构、文件哈希判断能不能部署；没有时行为不变。
- 改：`packages/supervisor/src/deploy/release.ts`（新）、`readiness.ts`、`server.ts`（`deployment` 加 `installRoot`）、`supervisor/src/main.ts`、`packages/supervisor/test/`。
- 验收：
  - 没有 `release.json` 的 checkout 上，现有闸门测试全部照旧通过。
  - 有 `release.json` 且哈希都对时，`deployReadiness` 返回 `ready: true, mode: "release"`，不调用 git。
  - 改掉一个 `files` 里的文件后，返回拒绝，原因写出文件名。
  - `arch` 不等于 `process.arch` 时拒绝。
  - 库的 schema 版本大于 `release.json.schemaVersion` 时拒绝，原因说明是降级。
  - `current` 指向安装根外面时拒绝。
- 依赖：无。

### P0-2 打包运行包的脚本

- 目标：一条命令从构建产物生成第 2 节的 arm64 运行包目录、tar.gz 和 `manifest.json`。
- 改：`scripts/desktop/pack-runtime.ts`（新）、`scripts/desktop/smoke-runtime.ts`（新）、`desktop/node-version`（新，写固定的 Node 版本）、`docs/desktop/`。
- 验收：
  - 脚本下载固定版本的 darwin-arm64 Node，用 `SHASUMS256.txt` 校验；哈希不对时失败退出。
  - Node 二进制在运行包里叫 `bin/lead-agent`；`bin/node` 是指向它的软链接；`bin/plc` 用 `bin/lead-agent` 运行。
  - 运行包的 `node_modules` 只含 better-sqlite3、`@earendil-works/pi-coding-agent`、`@anthropic-ai/sandbox-runtime` 及其依赖，版本和根 `package-lock.json` 一致。
  - better-sqlite3 的 `.node` 文件是 arm64，否则失败退出。`--arch` 只接受 `arm64`。
  - `release.json` 的 `product` 是 `bytezard-lead`；`files` 哈希和磁盘上的文件一致；`updateSource.repository` 来自参数，不写死。
  - 附件名是 `bytezard-lead-runtime-<版本>-arm64.tar.gz` 和 `manifest.json`。
  - 冒烟脚本用临时 `PLC_DATA_DIR` 从运行包启动 daemon，60 秒内 `plc.sock` 回答 `status`，然后停掉；`ps` 里 supervisor 和 daemon 的进程名都是 `lead-agent`。
  - 运行包里 pi 的 `--version` 能用 `bin/lead-agent` 运行成功。
- 依赖：无（P0-1 合并前，冒烟脚本可以先跳过闸门）。

### P0-3 `ops.mjs desktop-install` 和登录 shell 的 PATH

- 目标：在发布模式下一条命令装好 launchd 服务并等到健康，按行输出 JSON 进度；PATH 问题解决。
- 改：`apps/daemon/src/ops.ts`（`desktop-install`、`selfcheck`，发布模式不查 `AM_API_KEY`）、`packages/supervisor/src/deploy/launchd.ts`、`doctor.ts`（发布模式下 `AM_API_KEY`、aish 为可选）、`packages/core/src/config.ts`（新增 `installRoot()`，返回 `~/Library/Application Support/Bytezard Lead/runtime`）、`packages/runtime/src/executable.ts`（补已知目录、读 `login-shell-path.json`）、`packages/supervisor/src/main.ts`、`apps/daemon/src/main.ts`、测试。
- 验收：
  - plist 的 label 取 `LAUNCHD_LABEL` 常量；`ProgramArguments` 是 `<安装根>/current/bin/lead-agent` 和 `<安装根>/current/apps/daemon/dist/supervisor.mjs`，`WorkingDirectory` 是 `<安装根>/current`，不指向具体版本目录。
  - 重复运行是幂等的：第二次运行结束后只有一个 supervisor 进程。
  - 已有 plist 指向带 `.git`、没有 `release.json` 的目录时，不覆盖，输出 `dev_install_detected`。
  - 机器上还有 `com.pi-lead-child.supervisor` 的 plist 时，不安装，输出 `legacy_install_detected`。
  - 数据目录下 `plc.sock` 的完整路径超过 104 字节时，在安装前报错退出。
  - 每一步输出一行 JSON：`{step, state, message}`，失败时带错误码；同时写进 `install-state.json`。
  - 登录 shell 的 PATH 采集：命令是固定字符串，5 秒超时，`$SHELL` 不在 `/etc/shells` 时跳过；结果合并进 `runtimeSearchPath`。有单元测试覆盖超时和输出里混有其他文字的情况。
  - 所有路径都用参数数组传给子进程，不拼进 shell 命令；有测试用带空格的安装根跑通安装。
  - 发布模式下没有 `AM_API_KEY` 也能装好；开发模式下 `plc daemon install` 的行为不变。
- 依赖：P0-1、P0-2。

### P0-4 Electron 壳

- 目标：`desktop/` 下的 Electron App：首次打开装好服务，然后打开 Companion 网页；失败时能看懂、能重试；窗口标题是 Lead 名字。
- 改：`desktop/package.json`、`desktop/src/main.ts`、`desktop/src/preload.ts`、`desktop/src/install.ts`、`desktop/src/*.messages.ts`、`desktop/desktop-builder.yml`、`desktop/test/`；Companion 设置 `document.title` 的地方（`apps/companion/src/`）。
- 验收：
  - `desktop-builder.yml` 里 `appId` 是 `com.bytezard.plc`，`productName` 是 `Bytezard Lead`；打出的 Info.plist 里 `CFBundleName` 是 `Bytezard Lead`，`CFBundleIdentifier` 是 `com.bytezard.plc`。
  - `ready` 之前把 `userData` 设到 `<数据目录>/shell`；数据目录的根下没有 Chromium 的文件。
  - 不在「应用程序」里时，提示并能调用 `app.moveToApplicationsFolder()`。
  - 解包先到 `.partial` 目录，校验通过后才 rename；中途退出再打开时能从头恢复，不留半个版本。
  - 去 quarantine 用 `execFile("xattr", ["-dr", "com.apple.quarantine", dir])`，不经 shell。
  - 安装进度页按 `desktop-install` 的 JSON 进度显示；失败时有「重试」「查看日志」「复制诊断信息」。
  - 窗口只加载 `status.gatewayUrl`；同源以外的 `https:` 链接交给系统浏览器，其他协议拒绝；`nodeIntegration` 关、`contextIsolation` 开、`sandbox` 开。
  - 窗口标题是用户配置的 Lead 名字：用户在设置里改了名字，标题跟着变；安装页用上次记下的名字，第一次安装时用 `Paimon`。
  - 再次打开 App（服务已装好）时，直接打开窗口，不重新安装；运行包版本比已装的新时才解包。
  - 界面文字都在 `*.messages.ts`，有 `en` 和 `zh`，缺省英文；对外文案只用 `Bytezard Lead` 和 Lead 名字。
- 依赖：P0-3。

### P0-5 GitHub Actions、dmg 和安装说明

- 目标：发布 release 时自动打出 arm64 的 dmg 和运行包，挂到 release 上；用户照着说明能打开未签名的 App。
- 改：`.github/workflows/release-macos.yml`（新）、`desktop/desktop-builder.yml`（dmg 背景、`identity: "-"`、`hardenedRuntime: false`、`npmRebuild: false`、`artifactName`）、`desktop/assets/dmg-background.png`（及 `@2x`）、`README.md`（安装和「打不开怎么办」）、`docs/desktop/release-notes-template.md`。
- 验收：
  - workflow 只有一个 arm64 job（`macos-15`），没有构建矩阵。
  - 在一个测试 release 上，workflow 由 `release: published` 触发，`bytezard-lead-<版本>-arm64.dmg`、运行包 tar.gz、`manifest.json` 出现在 release 附件里。
  - 冒烟测试失败时 job 失败，不上传任何附件。
  - `workflow_dispatch` 填 tag 能重跑，`--clobber` 覆盖旧附件。
  - workflow 不读任何 secret；第三方 action 都固定到 commit SHA；只有这个 workflow 有 `contents: write`。
  - 在一台没装过的 Apple 芯片 Mac 上：下载 dmg → 拖进「应用程序」→ 按 README 的步骤「仍要打开」→ App 打开并装好服务。实测记录（macOS 版本、每一步截图）附在工单里。
  - dmg 背景图和 README 里的步骤与 Apple 支持文章 102445 一致，中英文都有，写明需要 Apple 芯片，只用 `Bytezard Lead` 这个名字。
- 依赖：P0-4。

### P0-6 首次启动引导里选执行器

- 目标：`FirstRunBrain` 之后列出 Codex、Claude Code、pi，已安装的默认勾上，没勾的写进 `runtimes.disabled`。
- 改：`apps/companion/src/features/onboarding/FirstRunRuntimes.tsx`（新）、`FirstRunGate.tsx`、`firstRunModel.ts`、`onboarding.messages.ts`、测试。开工前读 `docs/design/README.md`、`patterns.md`、`themes/default.md` 和 `packages/components/README.md` 的语义间距一节。
- 验收：
  - 数据来自现有的执行器设置接口，不新写探测。「重新检测」重新读取执行器设置（`GET /v1/runtimes/settings`）：daemon 每次读取都重新找可执行文件。不用 `/v1/runtimes/recheck`，因为它要 admin 权限，Companion 拿不到；它也只重检已有的故障，发现不了新装的执行器（2026-11-03 定，选项 A）。
  - 每项显示「已安装 / 没找到 / 内置」。「已登录」状态放到 P1：现有的执行器设置接口没有这一项。
  - 已安装的默认勾上；pi 总是可选，说明它是内置的。
  - 提交通过现有的 UI 操作写 `runtimes.disabled`，Lead 能用同一个操作做同样的事。
  - 「跳过」不改任何设置；这一步只在首次引导出现一次。
  - 间距和字号只用语义 token；文字有 `en` 和 `zh`。
- 依赖：无（可以和 P0-1 到 P0-5 并行）。

### P0-7 通知和登录项的实测，按结果定通知路径

- 目标：实测 ad-hoc 签名的 App 能不能发通知、未签名的 LaunchAgent 在「登录项与扩展」里显示什么名字；按结果实现通知路径，通知标题改成 Lead 名字。
- 改：`docs/desktop/macos-desktop-design.md`（第 8.6、11 节写回实测结果和选择）、`apps/daemon/src/server.ts`（`defaultDesktopNotifier` 的标题用 Lead 名字；有壳订阅时不调 osascript）、`packages/protocol/src/local-sockets.ts`（壳订阅桌面通知的消息）、`desktop/src/notifications.ts`（新，路径 A）、测试。选 B2 时再加 Swift 助手的源码和构建脚本，并先回来问用户。
- 验收：
  - 在一台 Apple 芯片 Mac 上，用 `identity: "-"` 本地打出的 App 调用 Electron `Notification`，记录：有没有弹出，有没有收到 `failed` 事件，通知中心里的来源显示什么。附截图和 macOS 版本。
  - 记录 daemon 的 osascript 通知在通知中心里显示的来源。
  - 用 `bin/lead-agent` 启动的 LaunchAgent 装好后，记录「已添加后台项目」通知和「系统设置 → 通用 → 登录项与扩展」里显示的名字；附截图。如果显示的是 Node 签名里的开发者名而不是 `lead-agent`，写进第 11 节，并提出下一步。
  - 按实测结果选路径 A、B1 或 B2，在第 8.6 节写明选了哪个、为什么；没选的方案保留「未核实」或改成实测结论。
  - 每条通知的标题是用户配置的 Lead 名字，用户改名后下一条通知用新名字；有单元测试。
  - 路径 A 下，App 开着时同一条通知只弹一次；App 关掉时 daemon 用 osascript 照常弹出；有测试覆盖两种情况。
  - 测试里 `PLC_DESKTOP_NOTIFY=off` 照旧生效，测试不在桌面上弹通知。
- 依赖：P0-3、P0-4。

### P0-8 改名和开发机迁移（P0 最后一张）

- 目标：代码里的缺省名字换成新名字；开发机一条命令从 `~/.pi-lead-child`、`com.pi-lead-child.supervisor` 迁到新名字；迁移前在线备份数据库，任何一步失败都能回滚到旧名字并照常运行。
- 改：
  - 缺省名字：`packages/core/src/config.ts`（`dataDir()` 的缺省路径；`:417` 给执行器看的说明）、`packages/core/src/sandbox-policy.ts`、`packages/supervisor/src/deploy/launchd.ts`（`LAUNCHD_LABEL`；旧 label 加进 legacy 清单）、`packages/supervisor/src/deploy/hindsight.ts`（`HINDSIGHT_LABEL`）、`packages/supervisor/src/deploy/doctor.ts`。
  - 给模型看的文字里的旧路径：`packages/lead/src/tools.ts`、`skill-tools.ts`、`credential-guard.ts`、`templates/pr-review.ts`、`packages/engine/src/ui-actions/installs.ts`、`packages/engine/src/installs/skills.ts`、`apps/daemon/src/lead-installs.ts`、`apps/daemon/src/hindsight-main.ts`。
  - 迁移命令：`apps/daemon/src/ops.ts`（新增 `migrate-data-dir`）、`packages/supervisor/src/deploy/`（新增迁移模块）、测试。
- 迁移步骤（`ops.mjs migrate-data-dir`）：
  1. 预检：旧目录和旧 plist 存在；新目录不存在或为空；新目录所在磁盘的剩余空间够放一份数据库备份；新的 `plc.sock` 路径不超过 104 字节。任何一项不过就退出，什么都不改。
  2. 在线备份：daemon 还在运行时，用 SQLite 的在线备份（better-sqlite3 的 `db.backup()`）把 `plc.db` 备份到 `~/.pi-lead-child/backups/pre-rename-<时间>.db`，输出备份路径。
  3. 扫描 `plc.db` 和 `config.json` 里写着旧路径的字段，列出表、列和行数。
  4. 排空：复用 supervisor 维护流程的排空判断，等 Lead 这一轮结束、执行器排空。
  5. 先 bootout 旧的 `com.pi-lead-child.supervisor` 和 `com.pi-lead-child.hindsight`，确认进程都退出了。旧 plist 改名为 `.plist.pre-rename` 留着，不删。
  6. 用 `rename` 把旧目录移到新位置（同一个卷，原子操作）。不留指向旧路径的软链接：执行器沙箱的禁读清单按新路径生成，软链接会绕过它。
  7. 在一个事务里把第 3 步找到的旧路径改成新路径。
  8. 开发模式下，用 `scripts/desktop/lib/agent-bundle.ts` 的 `installAgent` 把开发机的 Node 复制到 `<数据目录>/bin/lead-agent` 并重新签名，建软链接 `<数据目录>/bin/Bytezard Lead`，plist 写这个软链接（第 8.7 节：只复制改名，登录项显示「Node.js Foundation」）。写新的 `com.bytezard.plc.supervisor` plist，plist 用这份副本启动，然后 bootstrap。Hindsight 不另起 launchd 任务，由 supervisor 运行（第 8.7 节）。以前的版本留下的 `com.bytezard.plc.hindsight` 任务在第 5 步停掉，它的 plist 删掉（#261：这个任务还加载着时，bootstrap 返回 error 5，整次接管回滚）。
  9. 健康检查：`plc.sock` 回答 `status`，schema 版本和迁移前一样。通过后删掉旧 plist 的 `.plist.pre-rename`。
  10. 回滚：第 5 步以后任何一步失败，就 bootout 新 label、删新 plist、把目录移回旧位置、用第 2 步的备份恢复库（第 7 步已经改过时）、把旧 plist 改回原名并 bootstrap。回滚的每一步都记日志。
- 验收：
  - 新机器（没有旧目录）直接用新名字，不运行迁移。
  - 有旧目录的开发机：一条命令迁完。迁完后 `launchctl print gui/<uid>/com.bytezard.plc.supervisor` 能查到，旧 label 查不到；`plc status` 正常；迁移前后 items、会话、连接的行数一致。
  - 迁移前一定有在线备份，备份路径写在输出里。
  - 集成测试用注入的故障覆盖这几处：备份后、bootout 后、移动目录后、改写路径后、新服务健康检查失败。每种情况都回滚到旧名字，旧服务能起来，数据和迁移前一致。
  - 重复运行是幂等的：迁完后再运行，直接报告「已经迁移过」并退出；回滚后再运行，能重新迁移。
  - 代码里除了迁移模块和 legacy label 清单，不再出现 `.pi-lead-child` 和 `com.pi-lead-child`（用 grep 检查，测试目录除外）。
  - 给模型看的文字里，数据目录写成 `~/Library/Application Support/Bytezard Lead/`，命令里的路径带引号。
  - 迁移后执行器在沙箱里读不到新路径下的 `config.json`、`cli-credential.json`、`connections.key`。
  - 开发机的「登录项与扩展」里不再显示 `node`；实测截图附在工单里。`plc daemon install` 每次重新复制 Node 副本；doctor 发现副本和开发机 Node 的版本不同时报错。
  - 在真实的开发机上运行迁移前，执行者先申请用户批准（`run_on_host` 的确认卡）。
- 实现说明（#206，2026-11-04）：
  - 旧名字只写在 `packages/core/src/pre-rename.ts` 和迁移模块 `packages/supervisor/src/deploy/data-dir-migration.ts` 里。
  - 合并以后、迁移以前，主 checkout 的构建在任何一次重启时就会生效。这段时间里 `dataDir()` 照旧用旧目录：旧目录在、新目录不存在或为空时就是这样。用旧目录的进程也用旧的 launchd 任务（`activeLaunchdLabel`、`hindsightLabel`），不另装一个 Hindsight 抢同一个端口。`plc daemon install` 在这种机器上拒绝，提示先迁移。
  - 第 7 步只改代码当作路径或命令来用的列：`runs.session_path`、`runs.launcher`、`workspaces.path`、`items.workdir`、`watches.command`、`widget_sources.command`。事件、消息、核查结论这类历史记录不改，有的表本来就只许追加。第 3 步照样列出它们的行数。
  - 回滚时把同样几列里的新目录改回旧目录，不用第 2 步的备份覆盖库。迁移前这几列里没有新目录，所以改回去和迁移前完全一样，也不丢第 2 步之后 daemon 写下的东西。迁移前就有新目录时，才用备份恢复。
  - 预检多查两项：旧目录和新目录在同一个卷上；库的 schema 版本等于这份代码的最新版本。不等时先用新代码重启一次服务，再迁移，否则第 9 步的版本比较一定失败。
  - 运行：在主 checkout 构建以后，`node apps/daemon/dist/ops.mjs migrate-data-dir [--locale zh] [--follow]`。迁移在自己的会话里运行，进度按行写成 JSON，写进 `~/Library/Logs/Bytezard Lead/migrate-data-dir-<时间>.jsonl`。命令只启动迁移，输出日志路径就返回；`--follow` 时跟着日志输出，在终端里用。原因：Lead 用 `run_on_host` 启动的命令在 supervisor 的 launchd 任务的进程组里，第 5 步 bootout 时会跟着被停掉；Lead 那一轮也要先结束，第 4 步的排空才等得到。
- 依赖：P0-1、P0-2、P0-3、P0-4、P0-5、P0-6、P0-7 全部合并。

### P1-1 pi 兜底用 Lead 的服务商

- 目标：用户没装 Codex 和 Claude Code 时，pi 执行器直接用 Lead 在首次引导里配的服务商和模型。
- 改：`packages/runtime/src/pi.ts`、`apps/daemon/src/`（生成 pi 的 provider 配置）、测试。
- 验收：
  - 第一步先在工单里写明 pi 1.1.0 怎样指定独立的 agent 目录（引用 pi 的源码位置）。
  - pi 执行器用的配置目录在数据目录下，不读写用户的 `~/.pi`。
  - 用户自己的 `~/.pi` 已经有可用 provider 时，优先用用户的。
  - 生成的配置文件权限是 0600；key 不写进日志和 profile。
  - 只有 Lead 服务商、没有别的 runtime 的机器上，一张执行工单能用 pi 跑完。
- 依赖：P0-2。

### P1-2 Hindsight 后台安装

- 目标：桌面版默认开启记忆；普通用户不装 uv 也能用；安装和模型下载不挡向导。
- 改：`packages/supervisor/src/deploy/hindsight.ts`（`findUvx` 先找 `<root>/bin`）、`hindsight-models.ts`、`apps/daemon/src/memory-controller.ts`、设置 → 记忆的界面和文案、`scripts/desktop/pack-runtime.ts`（带 uv）。
- 验收：
  - 新装的桌面版记忆开关缺省是开。
  - 运行包里的 uv 固定版本、校验过哈希。
  - 向导完成时不等 Hindsight；剩余空间 ≥ 6 GB 时在后台下载模型；设置 → 记忆显示下载进度和失败原因，能重试。
  - 剩余空间少于 6 GB 时不开始下载，并说明原因。
  - 记忆没准备好时，Lead 和其余功能照常工作。
- 依赖：P0-2。

### P1-3 运行包自动更新

- 目标：有新版时 Lead 和用户都能知道；一次更新能自动下载、校验、切换、失败回滚；Lead 可以自己触发，事后告诉用户。
- 改：`packages/protocol/src/local-sockets.ts`（`targetVersion`）、`packages/supervisor/src/server.ts`（每次 spawn 前从 `current` 解析命令、换 `current`、回滚、升级后自己退出）、`apps/daemon/src/`（检查和下载）、`packages/engine/src/ui-actions/`（`update.check`、`update.apply`）、`packages/gateway/src/`（HTTP 路由）、设置页文案、测试（含完整升级流程的集成测试）。
- 验收：
  - 检查用 `/releases/latest/download/manifest.json`，不调 REST API；仓库来自 `release.json.updateSource`。
  - 下载走 HTTPS；文件 SHA-256 不对时，不切换，旧版本照常运行，并告诉用户。
  - 升级流程：排空 → 备份 → 停 daemon → 换 `current` → 启动 → 校验，每一步记进维护记录。
  - 新版本校验失败时，`current` 换回旧版本，旧版本的 daemon 起来；库已迁移时先从备份恢复。有集成测试覆盖。
  - 升级成功后 supervisor 退出，launchd 拉起的是新版本的 supervisor（集成测试用假 launchd 验证）。
  - 只保留 `current` 和上一个版本。
  - `update.check`、`update.apply` 各有 HTTP 路由和 Lead 工具，调同一个函数；都声明为 `lead_allowed`、`changesRules: false`。
  - Lead 触发的更新结束后，用户收到一条说明：从哪个版本到哪个版本、成功还是已回滚、原因。
- 依赖：P0-1、P0-3、P0-5。

### P1-4 壳的新版提示

- 目标：App 壳有新版本时，窗口里提示并给出下载链接；不自动替换。
- 改：`desktop/src/main.ts`、`desktop/src/preload.ts`、`desktop/src/*.messages.ts`；`manifest.json` 加 `shellVersion` 和 `minShellVersion`。
- 验收：
  - 壳版本低于 `shellVersion` 时显示一次提示，用户关掉后同一版本不再提示。
  - 壳版本低于 `minShellVersion` 时，运行包更新先不切换，提示用户先更新 App。
  - 下载链接打开系统浏览器。
- 依赖：P0-4、P0-5。

### P1-5 卸载

- 目标：用户能从 App 里卸载干净，数据默认保留。
- 改：`apps/daemon/src/ops.ts`（`desktop-uninstall [--purge]`）、`desktop/src/main.ts`（菜单）、文案。
- 验收：
  - 卸载后 `launchctl print gui/<uid>/com.bytezard.plc.supervisor` 和 `com.bytezard.plc.hindsight` 都查不到，两个 plist 都删掉，`<数据目录>/runtime/` 和 `<数据目录>/shell/` 删掉。
  - 默认保留数据目录里的其他内容；选删除数据时先列出目录和大小，用户确认后才删。
  - 卸载后重新安装能正常工作，保留的数据还在。
- 依赖：P0-3、P0-4、P0-8。

### P1-6 PR 上的冒烟测试

- 目标：改到打包脚本或壳的 PR，在合并前就跑一次运行包冒烟测试，不等到发版才发现打包坏了。
- 改：`.github/workflows/desktop-smoke.yml`（新，`pull_request`，路径过滤 `scripts/desktop/**`、`desktop/**`、`apps/daemon/scripts/build.ts`、`package-lock.json`）、`scripts/desktop/smoke-runtime.ts`。
- 验收：
  - 在 `macos-15`（arm64）上打出运行包并跑冒烟测试；不打 dmg，不上传附件，权限只读。
  - 冒烟测试失败时 PR 的检查失败。
  - 和 `release-macos.yml` 调用同一个冒烟脚本。
- 依赖：P0-5。

### P2

| 工单 | 目标 | 依赖 |
|---|---|---|
| P2-1 壳自动替换 | 下载壳的 zip，校验后替换 App 并重开 | P1-4 |
| P2-2 更新清单签名 | CI 用 Ed25519 签 `manifest.json`，App 内置公钥校验 | P1-3 |
| P2-3 `plc` 进 PATH | 设置里的开关，打开后建 `~/.local/bin/plc` 软链接；开关是一个 UI 操作，有 HTTP 和 Lead 两个入口 | P0-3 |
| P2-4 Apple 签名和公证 | 有证书以后：Developer ID 签名、公证，改用 `electron-updater`；按需要加 plist 的 `AssociatedBundleIdentifiers` | 有证书 |
| P2-5 执行器手动指定路径 | 设置 → 执行器里填可执行文件路径，写进 config.json | P0-6 |

## 11. 未核实的事实

| 事实 | 现状 | 怎样核实 |
|---|---|---|
| Apple Silicon 要求原生代码至少有 ad-hoc 签名 | 只有二手引述 | 找 Apple 开发者发行说明原文，或在干净机器上测完全不签的构建 |
| ad-hoc 签名的 dmg 下载后能通过「仍要打开」启动 | 未实测 | P0-5 验收 |
| ad-hoc 签名的 Electron App 能发通知 | Electron 文档原文：「For notifications on macOS, your application will need to be code-signed … Unsigned binaries will emit a `failed` event」。2026-11-04 实测（macOS 27.2，Lead 转述主人的截图）：能发。首次运行弹出权限卡，卡上和「系统设置 → 通知」里的名字都是 Bytezard Lead；授权前发的那条收到 `show` 但不显示；授权后重跑能弹出，没有 `failed`。实测 5（17:13）：probe 有 `show`、没有 `failed`，但通知中心里没有这一条，`ncprefs` 里没有 `com.bytezard.plc` 的记录，推测没有申请到通知授权。#232：`ncprefs` 在 macOS 27.2 上已经不再写入，不能当证据；壳改为用户确认测试通知显示以后才接管通知，见第 8.6 节 | 实测 6：读授权申请的结果；换构建以后授权在不在；关掉通知以后有没有 `failed` |
| daemon 用 osascript 发的通知，通知中心里显示的来源 | 2026-11-04 实测 2、5：通知进通知中心，标题是参数给的 Lead 名字；图标是脚本编辑器的通用图标，没有单独的 App 名，不是 Bytezard Lead（主人 17:19 截图）。实测 5 横幅没有弹出，原因没查 | 已实测；横幅不弹的原因没查 |
| 原生通知助手（B2，`UNUserNotificationCenter`）在 ad-hoc 签名下能发通知 | 未查，未实测 | 只在 P0-7 选 B2 时实测 |
| ad-hoc 签名的后台程序，登录项显示什么名字 | 2026-11-04 实测 3、4（截图）：显示 plist 里 `ProgramArguments[0]` 那个路径的文件名；是软链接时显示软链接自己的名字（p7、p8）；放在程序包里时显示可执行文件名（p1–p3、p5），程序包的目录名、`CFBundleName` 不起作用。`sfltool dumpbtm` 的 Name 和设置页不一致 | 已实测 |
| ad-hoc 签名的程序用 `AssociatedBundleIdentifiers` 能归到 App 名下 | 2026-11-04 实测 3：不能。ad-hoc 签名（p2）和 Node 官方签名（p4）下都不起作用。Developer ID 签名时的情况见 [Apple 论坛 713493](https://developer.apple.com/forums/thread/713493) | 已实测；有证书以后（P2-4）再测 |
| `SMAppService` 在 ad-hoc 签名的 App 里能注册后台服务 | Electron 文档说要签名和公证才可靠；没有实测 | 只在用户选方案 2 时实测 |
| 可执行文件叫 `Bytezard Lead`（带空格）时，登录项和进程名各显示什么；软链接能不能让两者不同 | 2026-11-04 实测 4（截图）：p6 登录项和进程名都是 `Bytezard Lead P6`；p8（plist 写软链接 `Bytezard Lead P8`，真实文件 `lead-agent-p8`）登录项显示 `Bytezard Lead P8`、进程名 `lead-agent-p8`。所以软链接能让两者不同，做法 1b 据此选定。实测 5（p9，交付的做法）：登录项显示 Bytezard Lead，进程名 `lead-agent` | 已实测 |
| 未签名 LaunchAgent 在「登录项与扩展」里显示的名字 | 2026-11-04 实测：用 Node 改名副本启动的 LaunchAgent 归到「Node.js Foundation」下面，和开发机上原有的 node 后台项目合在一起。ad-hoc 重签以后显示 plist 里路径的文件名（实测 3、4）。这台机器装了 MDM 和安全软件，一直没有弹出「已添加后台项目」通知，原因未确认 | 已实测；「已添加后台项目」通知要在没装 MDM 的 Mac 上再看 |
| 带 Node 官方签名的 Node 改名为 `lead-agent` 后，登录项显示文件名还是签名里的开发者名 | 2026-11-04 实测：显示签名里的开发者名「Node.js Foundation」。第 9 节决定 7 只靠改名做不到，已改成重签加软链接（第 8.7 节，做法 1b）。同时出现两条以 `node` 署名的隐私提示，触发者未确认 | 用 TCC 日志确认两条提示的进程路径 |
| 用 Node 下载的运行包不带 quarantine 属性 | 未实测 | P1-3 验收时 `xattr -l` 检查 |
| 后台项目被关掉时 `launchctl bootstrap` 的具体错误 | 未实测 | P0-3 在本机关掉开关后复现 |
| pi 能否用环境变量指定独立的 agent 目录 | 未查 | P1-1 第一步读 pi 1.1.0 源码 |
| Electron、electron-builder 的具体版本 | 未定 | 实施时从 npm 官方 registry 查最新稳定版并锁定 |

## 12. 存量安装的自动接管

用户 2026-11-04 19:20、19:30 定下：装上安装包就自动继承已有的数据和配置，不要求用户开终端、敲命令，也不要求用户点额外的确认（#234）。这一节取代第 4.2 节第 3 步原来的做法：原来遇到开发安装时不接管，遇到改名以前的安装时拒绝安装。

### 12.1 总的做法

- `desktop-install` 在 `detect` 后面加一步 `takeover`。识别出存量安装时自动接管，接管完接着走原来的步骤（登录 shell 的 PATH、launchd、启动）。
- 接管复用迁移模块 `packages/supervisor/src/deploy/data-dir-migration.ts`（P0-8），用同一套预检、备份、排空、停服务、启动、健康检查和回滚。不另写一套。迁移模块多了一个参数：新服务跑开发 checkout（`ops.mjs migrate-data-dir`），还是跑安装包的运行目录 `<安装根>/current`（接管）。
- 接管只改 launchd 的 plist，让它指向 `<安装根>/current`。旧的开发 checkout 不删，也不改。
- 安装页多一行「接手已有的数据和设置」，只在接管时出现。下面的说明文字跟着每一步变。
- 从停旧服务开始，任何一步失败都自动回滚到原样。安装页用大白话说明原因，给「重试」。

### 12.2 怎样判断是哪种情况

按下面的顺序判断，命中一种就不再往下看。

| 情况 | 判断依据 | 处理 |
|---|---|---|
| A. 改名以前的安装 | `~/Library/LaunchAgents/com.pi-lead-child.supervisor.plist` 存在；或者 `~/.pi-lead-child/` 存在，而新的数据目录不存在、或者里面只有 App 自己的 `runtime/`、`shell/` | 把数据目录搬到新位置，接管服务（第 12.3 节） |
| B. 已经迁移，但跑的是开发 checkout | `com.bytezard.plc.supervisor.plist` 的 `WorkingDirectory` 里有 `.git`，没有 `release.json` | 数据不动，接管服务（第 12.4 节） |
| C. 已经是安装包版本，换了版本 | plist 指向这次的 `<安装根>/current`，并且上次装好的版本（`install-state.json` 的 `installedVersion`）和 `current` 的版本不同 | 重启到新版本（第 12.5 节） |
| 新机器，或者再装一次同一个版本 | 以上都不是 | 照第 4.2 节的步骤，不迁移 |

- 情况 A 只在数据目录是缺省位置时判断（没设 `PLC_DATA_DIR`，或者它就是缺省位置）。
- App 第一次打开时就建了 `<数据目录>/shell/`，解包时建了 `<数据目录>/runtime/`。所以「新数据目录是空的」改成「新数据目录里只有 App 自己的文件」。core 的 `preRenameLayoutActive` 用同一条规则：App 装上以后、接管完成以前，开发机的代码照旧用旧目录，不在新目录里另开一个空库（第 12.9 节）。
- 开发者要保持开发安装时，用第 12.8 节的开关。开关打开时，情况 A 和 B 都不接管。

### 12.3 情况 A：改名以前的数据目录和服务

步骤和 P0-8 的迁移一样：`precheck`、`backup`、`scan`、`drain`、`stop_old`、`move`、`rewrite`、`start_new`、`health`。和开发机迁移不同的地方：

1. **预检。** 新数据目录里可以有 App 自己的 `runtime/`、`shell/`。旧目录里也有同名的项时，不接管（`target_not_empty`）。旧的 plist 不在（服务卸掉了）也接管，只搬数据。库的 schema 版本可以比安装包旧，启动时新版本会升级它；比安装包新时不接管（`schema_ahead`），什么都不改。剩余空间按库的大小算，schema 要升级时按两倍算。
2. **移动。** 新数据目录不存在或者是空的时，照旧整个 `rename`。里面有 App 的文件时，把旧目录里的项逐个 `rename` 进去（同一个卷，每一项都是原子的），最后删掉空的旧目录。
3. **启动。** plist 用 `desktopPlistOptions(<安装根>/current)`：`<安装根>/current/bin/Bytezard Lead` 启动 `supervisor.mjs`。不复制开发机的 Node。
4. **Hindsight。** 和 P0-8 一样，旧的 Hindsight plist 换成新 label 和新目录。新的 daemon 启动后按运行包的命令重写这个 plist。记忆数据在 Postgres 里（嵌入式的在 `~/.pg0`），接管不碰它。

备份：

- `backup` 一步在线备份 `plc.db` 到 `<数据目录>/backups/pre-rename-<时间>.db`，在排空和停服务之前。
- schema 要升级时，`stop_old` 停完服务以后再复制一份 `pre-rename-<时间>-stopped.db`。这时没有进程在写库，这一份就是停服务时的原样，回滚用它。

回滚（从 `stop_old` 开始任何一步失败）：

1. bootout 新任务，删新 plist。
2. 恢复库：schema 变了时用 `-stopped.db` 覆盖；没变时把改写过的几列改回旧目录（P0-8 的做法）。
3. 恢复 `config.json`。
4. 把搬过去的项逐个移回旧目录。
5. 把旧 plist 改回原名，bootstrap 旧服务。

### 12.4 情况 B：已经迁移，但跑的是开发 checkout

数据已经在新目录里，只换服务。用迁移模块的「原地」方式（`oldDir` 和 `newDir` 相同），不做 `scan`、`move`、`rewrite`。

1. **预检。** plist 在；库的 schema 版本不比安装包新；剩余空间够放备份。
2. **备份。** 在线备份 `plc.db` 到 `<数据目录>/backups/pre-takeover-<时间>.db`。开发安装的 plist 复制一份到 `<数据目录>/backups/pre-takeover-<时间>.supervisor.plist`，开发者要回到开发安装时参考。
3. **排空。** 和 P0-8 一样：等 Lead 这一轮结束、没有接管不了的执行，最多 30 分钟。
4. **停旧服务。** bootout `com.bytezard.plc.supervisor`，等 `supervisor.sock` 和 `plc.sock` 都连不上。plist 改名为 `.plist.pre-takeover`。schema 要升级时，复制一份 `pre-takeover-<时间>-stopped.db`。
5. **启动。** 写指向 `<安装根>/current` 的 plist，bootstrap。
6. **健康检查。** `plc.sock` 回答 `status`，库的 schema 版本等于安装包的版本。通过后删掉 `.plist.pre-takeover`。

不改的东西：开发 checkout、`<数据目录>/bin/lead-agent`（开发机的 Node 副本）、Hindsight 的 launchd 任务（新的 daemon 启动后自己重写它的 plist）。

回滚：bootout，删新 plist，把 `.plist.pre-takeover` 改回原名；schema 变了时用 `-stopped.db` 恢复库；bootstrap 开发安装的服务。

### 12.5 情况 C：已经是安装包版本，换了版本

App 带的运行包比装着的新时，壳先解包、把 `current` 换到新版本，再运行 `desktop-install`。plist 写的是 `current`，内容没变，原来不会重启服务，旧版本的进程会一直跑。现在按情况 B 的原地方式重启一次：

- 判断依据：`desktop-install` 每次装好时把运行包的版本写进 `install-state.json` 的 `installedVersion`。这次的版本和它不同就是换了版本。#234 以前的安装没有这一项，第一次换版本照旧不重启。
- 备份：`<数据目录>/backups/pre-upgrade-<时间>.db`；schema 要升级时，停服务后再复制一份 `-stopped.db`。2026-11-05 起改成只留一份 `pre-upgrade.db`，见第 7.5 节。
- 2026-11-05 起按更新的种类决定要不要重启（第 7.5 节）：只改了网页、命令行或者 App 壳时不重启，也不备份。
- 回滚：除了情况 B 的几步，还把 `current` 指回上一个版本 `versions/<旧版本>/`，再 bootstrap。

### 12.6 不重复迁移

- 情况 A 完成后，旧目录和旧 plist 都没有了，下一次判断不会再命中 A。
- 情况 B、C 完成后，plist 指向 `current`，`install-state.json` 记着这个版本。再装一次同一个版本时，launchd 一步报「已经设置好」，不重启服务。
- 同时只能有一个 `desktop-install`：它在 `<安装根>/install.lock` 里写自己的 pid。用户在接管中途退出 App 再打开时，后一个看到前一个还活着，就报 `install_running`，说明「上一次安装还在进行」。前一个进程已经退出时，后一个接着做。
- 接管的进程是 App 的子进程，不在 launchd 任务的进程组里，所以停旧服务时不会被一起停掉。App 中途退出时，它照样做完（输出管道断了也不中断）。

### 12.7 安装页显示什么

```
┌──────────────────────────────────────────┐
│  正在准备 Bytezard Lead…                  │
│  ✓ 复制程序文件                           │
│  ◌ 接手已有的数据和设置                    │  ← 只在接管时出现
│      正在等 Bytezard Lead 做完手上这一轮工作 │  ← 跟着每一步变
│  · 设置后台服务                           │
│  · 启动服务                               │
└──────────────────────────────────────────┘
```

每一步的说明：

| 步骤 | 说明 |
|---|---|
| 识别 | 「找到了旧名字的安装，接下来把数据和设置搬到 Bytezard Lead。」或「找到了开发版的安装，接下来让 Bytezard Lead 接手它的数据和设置。」或「接下来从 1.2.0 换到 1.3.0。」 |
| precheck | 正在检查能不能接手。 |
| backup | 正在备份数据库。 |
| scan | 正在查找数据里记着旧位置的地方。 |
| drain | 正在等 Bytezard Lead 做完手上这一轮工作。最多等 30 分钟。 |
| stop_old | 正在停下原来的后台服务。 |
| move | 正在把数据搬到新位置。 |
| rewrite | 正在更新数据里记着的位置。 |
| start_new | 正在用新的后台服务启动。 |
| health | 正在确认服务正常、数据完整。 |
| 回滚中 | 出了问题，正在恢复原样。 |

失败时：

| 结果 | 安装页的话 |
|---|---|
| 预检没过（什么都没改） | 说明哪一项没过，例如「原来的数据和新位置不在同一块磁盘上」「你的数据比这个安装包新，请下载更新的版本」，最后一句是「什么都没改，原来的服务照常运行。」 |
| 停服务以前失败（备份、排空） | 「没能接手原来的安装：<原因>。什么都没改，原来的服务照常运行。」 |
| 回滚成功 | 「没能接手原来的安装，已经恢复原样：数据没有改动，原来的服务照常运行。原因：<原因>。」 |
| 回滚也没成功 | 「没能接手原来的安装，恢复原样时也出了问题：<原因>。数据没有删除，数据库的备份在 <路径>。请点『复制诊断信息』发给我们。」 |

每种失败都有「重试」「查看日志」「复制诊断信息」三个按钮。「重试」从头再判断一次：回滚后的机器回到接管前的样子，所以重试就是重新接管。

壳的「再次打开」原来只看 `plc.sock` 回答 `status` 就直接打开。现在还要看 plist 指向这份 App 的 `<安装根>/current`；不是时走 `desktop-install`，这样情况 B 回滚后再打开 App，会再试一次接管。

### 12.8 开发者保持开发安装

- 环境变量 `PLC_KEEP_DEV_INSTALL=1`。缺省没有，普通用户碰不到。
- 打开时，`desktop-install` 不接管情况 A 和 B：不写 plist，不重启，直接打开在跑的那份（`dev_install_detected`）。
- 从访达打开的 App 读不到终端里的环境变量。先运行 `launchctl setenv PLC_KEEP_DEV_INSTALL 1`，再打开 App；不要了就运行 `launchctl unsetenv PLC_KEEP_DEV_INSTALL`。
- 已经被接管、又想回到开发安装：在 checkout 里运行 `node apps/daemon/dist/ops.mjs install`，它把 plist 写回 checkout。同时打开上面的开关，不然下次打开 App 会再接管一次。

### 12.9 和开发机代码的配合

- core 的 `preRenameLayoutActive`：新数据目录里只有 App 自己的 `runtime/`、`shell/` 时也算空。没有这一条时，App 一装上，开发机的 CLI 和重启后的 daemon 就会改用新目录，在里面开一个空库。
- 开发机要先跑上带这一条的代码，再装 App。否则在接管完成以前，开发机的进程可能在新目录里建文件；预检看到新目录里有别的文件就不接管（`target_not_empty`），什么都不改。
- 壳的「查看日志」不再新建 `<数据目录>/logs/`：目录不存在时打开安装根。
