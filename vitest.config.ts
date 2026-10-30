import { configDefaults, defineConfig } from "vitest/config";

// 仓库此前没有 vitest 配置，于是 testTimeout 一直是缺省的 5s。这个值对本仓库是错的：
// 大量用例要起真实子进程（children/manager）、真实 HTTP server（gateway、artifact 下载）、
// 真实 SQLite 文件，而被测代码自身的耐心就有 15s（web-tools 的 fetch 超时）。测试的耐心
// 小于生产代码的耐心，结果是全量并行抢 CPU 时先撞测试超时——表现为随机失败、单独跑必过。
//
// 症状一直被逐个用例绕过：截至本次，test/ 里已经有 20 处手写的 `}, 20_000)` 之类的尾参。
// 那是在同一个系统性问题上打了 20 个补丁。这里统一抬到 15s，与生产代码的耐心对齐；
// 个别确实更慢的用例仍可用尾参单独放宽。
//
// 代价是真正挂死的用例要 15s 才报错，而不是 5s。对一个本地跑、串行看结果的个人项目，
// 拿这个换掉随机红是划算的。
// 另外，本仓库有大量测试会同时启动真实 HTTP/WebSocket/Unix socket server。受限执行环境下
// 文件级并发会把这些 listener 放大成 `listen EPERM` 风暴，导致全量 `npm test` 红、单文件
// 复跑绿。默认串行跑根测试，牺牲一点墙钟时间，换来可复现的门禁结果。
//
// 另有一个约每十轮出现一次的偶发失败，症状是 `AssertionError: expected false to be true`。
// 它在本分支之前就存在（steer-stop / linger / daemon / aish-adapter 在 master 上即如此）。
// 追查它三次都栽在同一件事上：终端输出被 grep 过滤掉了失败的用例名，等想起来要看时已经冲掉。
// 所以这里常驻一个 json reporter——下次再红，`.vitest-report.json` 里直接有是哪个文件哪个
// 用例，不必再靠复现。用完即弃，已进 .gitignore。
//
// Claude Code 的子 agent 把 git worktree 建在 .claude/worktrees/ 下，也就是仓库目录里面。
// vitest 默认在整个仓库里找测试文件，于是会把每个 worktree 的整套测试也跑一遍。
// 所以这里把 .claude/ 排除在外。
//
// 根配置只跑后端各包、apps/daemon 和 apps/cli 的测试。apps/companion 和 packages/components 是 React Native 代码，各自有 vitest 配置。
// 测试用例按仓库根解析路径（例如 node_modules/.bin/tsx），所以各包的 test 脚本也先回到仓库根再跑。
//
// 测试会起真实的 daemon，有的在测试进程里，有的在子进程里。没有客户端连着时，daemon 会用
// osascript 弹 macOS 桌面通知，以前每跑一次测试，用户桌面上都会弹出 blocker 通知。
// PLC_DESKTOP_NOTIFY=off 关掉缺省的桌面通知。它是环境变量，所以子进程里的 daemon 也能收到。
//
// 测试启动的垫片和 fake CLI 以前会留在机器上：重启接管的测试三天里留下了 82 个孤儿进程，测试照样通过。
// vitest.setup.ts 在每个测试文件结束时检查这个文件没有留下这类进程。留下时，这个文件失败，并列出这些进程。
//
// 测试新建的临时目录以前也从来不删：2026-10-13，TMPDIR 里积累了约 149,000 个 plc-* 目录，共 167 GiB。
// 测试用 tempDir（@pi-lead-child/core/testing）新建目录。vitest.setup.ts 在文件结束时删除这些目录，
// 再检查这个文件没有留下别的 plc-* 目录。留下时，这个文件失败，并列出目录和新建它的位置。
//
// 网关总是开着，没配置端口时监听 47130，那是用户真实 daemon 的端口。测试里的 daemon 要是占了它，
// 浏览器里的 companion 会连到测试 daemon 上。PLC_GATEWAY_PORT=0 让测试里的网关都用随机端口。
//
// daemon 停机时先排空 Lead：等正在跑的那一轮，缺省最多 12 秒。很多测试结束时 Lead 还停在一轮里（假会话 hang），
// 每个测试的收尾都会等满 12 秒。PLC_LEAD_DRAIN_MS=50 让测试里的 daemon 几乎不等；要测排空的测试自己设。
//
// 打开交付里的文件（工单 07）时，daemon 在 macOS 上执行 open，会在用户桌面上打开文件。PLC_OPEN_FILES=off 让测试里的 daemon
// 缺省用一个一律拒绝的 opener（engine 的 daemonFileOpener）。要测打开文件的测试自己注入假的 opener。
export default defineConfig({
  test: {
    env: { PLC_DESKTOP_NOTIFY: "off", PLC_GATEWAY_PORT: "0", PLC_LEAD_DRAIN_MS: "50", PLC_OPEN_FILES: "off" },
    setupFiles: ["./vitest.setup.ts"],
    include: ["packages/*/test/**/*.test.ts", "apps/daemon/test/**/*.test.ts", "apps/cli/test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ".claude/**", "packages/components/**"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    fileParallelism: false,
    maxWorkers: 1,
    reporters: ["default", "json"],
    outputFile: { json: "./.vitest-report.json" },
  },
});
