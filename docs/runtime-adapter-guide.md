# 接入一个 runtime

一个 runtime 是一个 adapter。adapter 启动外部 CLI，把 CLI 的原生输出转成归一化事件，并给失败分类。内核只经 registry 读 adapter 的知识。所以新增一个 runtime 时，不改内核模块。规则见 spec D8（`.scratch/runtime-reliability/spec.md`）。

## 你要写的三样东西

- adapter：`src/runtimes/<id>.ts`。它实现 `AgentRuntime`（启动、探针、preflight、profile），并导出一个 `RuntimeAdapter` 登记项（`src/runtimes/types.ts`）。
- fake CLI：`test/fake-<id>.ts`。它按场景输出 CLI 的原生格式，并记下收到的 argv 和环境。
- 一份 `ContractFake`：放在 `test/runtime-adapter-contract.test.ts` 的 `FAKES` 里。它告诉合约测试怎样用 fake CLI 启动 adapter。

## 步骤

注意：第 1 步是协议变更。开始之前，先和用户确认。

1. 在 `RuntimeId`（`src/store/types.ts`）和线上的 `KernelRuntimeId`（`packages/protocol`）里加上新的 id。
2. 写 adapter 的 `start()`。用 `launchProcess`（`src/runtimes/launcher.ts`）启动 CLI，不要直接 spawn。启动垫片让 CLI 在 daemon 重启时继续运行。
3. 用 `childEnvironment` 构造 CLI 的环境。不要加关闭用户配置的 flag（spec D6）。
4. 把凭据放进环境变量或 0600 的文件。不要把凭据放进 argv。
5. 用 `RuntimeEventSequencer` 发事件。每个 Run 只发一个 `run.started` 和一个终止事件（`run.completed` 或 `run.failed`）。
6. 写 adapter 的失败分类：先写 CLI 自己的文本规则，再交给 `matchProviderFailure` 和 `residualFailureCode`。认不出的失败是 unknown。
7. 写 profile。如果 `adapterProfile` 不认识你的 runtime，像 echo 一样手写它。
8. 在 `src/runtimes/registry.ts` 的 `BUILTIN_ADAPTERS` 里登记 adapter。内核里只有这里可以写 runtime 的名字。
9. 写 fake CLI。它要覆盖 `ContractFake.scenarios` 的每个场景，以及 D1 表里每一行的失败样本。
10. 在 `test/runtime-adapter-contract.test.ts` 的 `FAKES` 里加上 `ContractFake`。
11. 跑合约测试和架构测试：
    `npx vitest run test/runtime-adapter-contract.test.ts test/runtime-architecture.test.ts`

## 模型目录和 effort（2026-10-15）

PLC 不写死任何 runtime 的模型。adapter 从 CLI 自己读目录，Lead 从目录里选模型和 effort。

1. 实现 `discoverModels()`（`packages/runtime/src/types.ts`）。只跑只读的命令，例如 CLI 的模型列表或 `--help`。不读、不打印凭据。
2. 把解析写成纯函数，放进 `packages/runtime/src/model-discovery.ts`。用本机真实的 CLI 输出写测试。
3. 在结果里写明来源（`source`）和账号（`account`）。如果 CLI 还接受目录以外的模型名，用 `freeformModelPattern` 写出规则。
4. 发现失败时返回 `{ ok: false }`。daemon 把这个 runtime 的目录记成 unknown，不替它的 Run 选模型。
5. 把 `RuntimeStartRequest.effort` 转成 CLI 自己的 flag。先用 CLI 的 `--help` 核实 flag。用 `cliEffortValue` 校验档位，再放进 argv。
6. 没有明确的模型时，不传模型参数。CLI 用用户自己的配置。

## 用量事件（2026-10-21）

口径和规则见 `docs/adr/0001-token-usage.md`。adapter 要遵守下面几条：

1. 报模型处理的全部 token：输入（含缓存读取和缓存写入）加输出。子 agent 的用量也报。
2. 如果原生事件是一次调用的用量，按 `delta` 报。每次调用只报一次。
3. 如果原生事件是进程到目前的总量，按 `cumulative` 报。不要把一个回合的用量当成 `cumulative`。
4. 先用本机真实的 CLI 输出核对原生字段的含义，再写映射。把核对用的输出抽成只含数字的夹具，写进测试。

## 合约测试检查什么

注册函数是 `describeAdapterContract`（`test/runtime-adapter-contract.ts`）。每个登记的 adapter 都跑下面这些用例：

- 每个用例：恰好一个终止事件，并且它是最后一个事件。
- 正常完成：一个 `run.started`、session、助手消息、用量、一个 `run.completed`。
- 工具事件：成功和失败的工具调用都报告，结果排在它的 `tool.started` 之后。
- 畸形行有上限：几行畸形行不影响完成。很多畸形行时 Run 失败，并停止 CLI。
- 缺少结果：CLI 以 0 退出却没有终止事件时，Run 失败，类型是 unknown。
- 中断：CLI 忽略 SIGTERM 时，宽限期之后 SIGKILL。CLI 和垫片都结束。
- resume 参数：CLI 收到要 resume 的 session，提示词完整。
- 环境：CLI 收到 daemon 的变量、adapter 和请求的变量、profile 的 PATH。argv 里没有工具桥 token。
- 用户配置：用户的 MCP 服务器或扩展照常加载，plc 也加载。
- 类型化失败：D1 表里每一行至少一个样本。失败的 Run 不留下 CLI 进程。
- 样本的文本取自历史失败的证据（`test/fixtures/runtime-failures.json`）。没有历史证据时，取自 CLI 的原文。

## 例子

`test/runtime-adapter-registry.test.ts` 里的 echo 是一个最小的登记项。它示范 `RuntimeAdapter` 的字段：模型规则、失败分类、展示名称和 `create()`。echo 不启动进程，所以它不跑合约测试。完整的例子是 `src/runtimes/codex.ts`、`test/fake-codex.ts` 和 `FAKES` 里的 `codex`。
