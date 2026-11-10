# 测试

本文说明仓库里的三套 vitest 测试怎样跑、怎样并发，以及哪些测试只在 macOS 上跑。

## 三套测试

| 命令 | 范围 | 配置 |
| --- | --- | --- |
| `npm test` | 后端各包、`apps/daemon`、`apps/cli`、`scripts/`、`desktop/` | `vitest.config.ts` |
| `npm run test:companion` | `apps/companion` | `apps/companion/vitest.config.ts` |
| `npm run test:components` | `packages/components` | `packages/components/vitest.config.ts` |

## 根测试：并发跑，沙箱里串行

缺省按文件并发跑，本机终端和 CI 都一样。每个 worker 是一个子进程（`pool: "forks"`）。

在受限的沙箱里（例如 Claude Code 或 PLC 执行器的沙箱）自动改成一次只跑一个文件。很多测试会起真实的 HTTP、WebSocket 和 Unix socket server。沙箱不允许监听 Unix socket，并发时会出现一片 `listen EPERM`。串行跑时，结果可以复现。

认沙箱看环境变量：有 `SANDBOX_RUNTIME` 或 `SRT_SSH_PROXY_COMMAND` 就串行。sandbox-runtime 给沙箱里的进程设这两个变量。

强制串行，例如排查一个只在并发时出现的失败：

```sh
PLC_TEST_SERIAL=1 npm test
```

根测试分两组（vitest 的 projects）：

- `shared`：`packages/store`、`packages/protocol`、`packages/client` 里不改全局状态的文件。这一组关掉隔离（`isolate: false`），同一个 worker 里的文件共用已经加载的模块。
- `isolated`：其余文件。每个文件重新加载全部模块。

文件里出现 `vi.mock`、`vi.spyOn`、`vi.stubEnv`、`vi.stubGlobal`、`vi.useFakeTimers`、`vi.resetModules`、给 `process.env` 赋值、`delete process.env`、`process.chdir` 中的任何一个，就留在 `isolated` 组（`vitest.config.ts` 的 `STATEFUL`）。分组看文件内容，新文件不用登记。

## companion 测试：按运行环境分两组

- `dom`：文件头写了 `// @vitest-environment happy-dom` 的文件。用 `vmThreads`：每个 worker 只建一次 DOM 环境，每个文件在新的 VM 上下文里跑。
- `node`：其余文件。用 `threads`，每个文件隔离。

两组都不关隔离：一半以上的文件用 `vi.mock`。

## 界面测试的 DOM 环境：happy-dom

companion 的 `dom` 组和 `packages/components` 的测试都在 happy-dom 里渲染。happy-dom 有几处和浏览器不一样，`test/domShims.ts` 在 setup 里补齐它们：媒体查询一律不匹配、去掉不会回调的 `ResizeObserver`、只让能聚焦的元素拿到焦点、补全 `flex` 的两值写法。两个包各有一份 `test/domShims.ts`，内容一样：包之间不能用相对路径互相引用。

happy-dom 的 `getComputedStyle` 会解析 CSS 变量，颜色照写法给出（例如 `#1868DB`、`transparent`，不换成 `rgb(…)`）。断言某处用了某个 token 时，用 `test/render.tsx` 的 `cssVar('--c-surface')` 取这个 token 的值来比。

## 只在 macOS 上跑的测试

产品只有 macOS 版。下面这些测试用到 macOS 自己的东西，在别的系统上跳过。CI 跑在 ubuntu 上，所以 CI 不跑它们。发版前在 Mac 上跑一次全量 `npm test`，它们就都跑了。

| 文件 | 跳过的范围 | 依赖 |
| --- | --- | --- |
| `packages/engine/test/sandbox-bash.test.ts` | 整个文件 | 真的沙箱（`sandbox-exec`） |
| `packages/engine/test/sandbox-extension.test.ts` | 整个文件 | 真的沙箱（`sandbox-exec`） |
| `packages/engine/test/sandbox-secrets.test.ts` | 整个文件 | 真的沙箱（`sandbox-exec`） |
| `packages/lead/test/hands.test.ts` | `Lead's hands in a pi session` 一组 | 真的沙箱里的 Lead bash |
| `packages/core/test/sandbox-policy.test.ts` | `sandboxTrustEnv` 一组 | 钥匙串里的证书（`security`） |
| `apps/daemon/test/vault-key.test.ts` | `the daemon's Keychain key` 一组 | 钥匙串 |
| `scripts/desktop/test/agent-bundle.test.ts` | 两条签名的用例 | `codesign` |
| `scripts/desktop/test/smoke.test.ts` | `smokeRuntime` 里查进程名的三条 | `ps -o comm=` 给出可执行文件的路径 |
| `desktop/test/runtime-bundle.test.ts` | `unpackRuntime re-uses what did not change` 一组 | `cp -c`（APFS 克隆） |

Linux 上的沙箱要 bubblewrap、socat 和 ripgrep。产品不在 Linux 上跑，所以 CI 不装它们，直接跳过前四个文件。

新写一个依赖 macOS 的测试时：

1. 用 `describe.runIf(process.platform === "darwin")` 或 `it.skipIf(process.platform !== "darwin")`。
2. 把它加进上面的表，也加进 `.github/workflows/pr-checks.yml` 开头的清单。

## CI 上 runner 和开发机的差别

- runner 上没有 codex 和 claude 两个 CLI。runtime 目录按可执行文件在不在判断能不能用，所以 CI 在 PATH 上放两个占位脚本。测试注入自己的假 runtime，不运行它们；真被运行时，占位脚本报错退出。
- 沙箱外执行命令用 `/bin/zsh -lc`。runner 默认没有 zsh，CI 先装上。
- `TMPDIR` 不能是 `/tmp` 本身：engine 有的测试把 session 目录往上两级当数据目录，那会是 `/`。CI 用 `runner.temp`。

## CI

`.github/workflows/pr-checks.yml` 的 job 同时开跑：

- `lint-and-types`：oxlint 和三次类型检查。
- `ui-tests`：components 的测试，和 companion 的测试分成 2 片（`--shard`）。
- `root-tests`：根测试分成 4 片，每片里按文件并发。
- `companion-tests-report`、`root-tests-report`：用 `vitest --merge-reports` 把各片的 blob 报告合成一份。任何一片失败或者没有交出报告，这个 job 失败。

## 本机复现一片 CI

```sh
npm test -- --shard=2/4
```
