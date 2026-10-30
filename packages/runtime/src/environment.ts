// child 的环境变量（spec D6）。
// 工单 10 曾经把 child 的环境改成白名单。2026-10-11，用户撤回了这个决定（工单 11）：
// child 要能用到用户独立运行同一个 CLI 时能用的一切，所以 child 继承 daemon 的全部环境。
// 例如 git 经 SSH 推送要的 SSH_AUTH_SOCK、`gh` 要的 GH_TOKEN、项目校验命令要的 JAVA_HOME。
// 工单 10 的其余部分保留：
// - PATH 由 profile 构造，daemon 的 Node 所在目录在最前。
// - 工具桥 token 不进 argv。
import { DAEMON_ONLY_ENV_NAMES } from "@pi-lead-child/core";
import { runtimeSearchPath } from "./executable.js";

type Env = Record<string, string | undefined>;
// spawn 要的类型是 ProcessEnv。这里构造的环境只有字符串值，可以直接交给 spawn。
export type ChildEnv = NodeJS.ProcessEnv & Record<string, string>;

export interface RuntimeEnvironment {
  // child 的 PATH。daemon 的 Node 所在目录排在最前（runtimeSearchPath）。
  path: string;
  // child 从 daemon 环境继承哪些变量。"all" 表示全部继承，和用户独立运行 CLI 时一样。
  inherit: "all";
  // adapter 自己设置的变量名，排好序。值不进 profile，因为它可能是凭据。
  adapterVariables: string[];
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function isVariableName(name: string): boolean {
  return VARIABLE_NAME.test(name);
}

// 一个 profile 的环境。PATH 不照抄，而是构造出来。
// 基础是 adapter 设置的 PATH，没有时用 daemon 的 PATH。构造时把 daemon 的 Node 所在目录放在最前。
export function runtimeEnvironment(adapterEnv: Env, daemonEnv: Env = process.env): RuntimeEnvironment {
  return {
    path: runtimeSearchPath(adapterEnv.PATH ?? daemonEnv.PATH ?? ""),
    inherit: "all",
    adapterVariables: Object.keys(adapterEnv).filter((name) => name !== "PATH").sort(),
  };
}

// child 实际收到的环境：daemon 的全部变量，加上 adapter 和请求自己设置的变量。请求的值优先。
// PATH 最后写入。所以 child 的 PATH 总是 profile 构造出的那一个，preflight 检查的也是它。
// daemon 自己的密钥（DAEMON_ONLY_ENV_NAMES）不给 child，不管它来自哪一层。
export function childEnvironment(
  environment: RuntimeEnvironment,
  adapterEnv: Env,
  requestEnv: Env = {},
  daemonEnv: Env = process.env,
): ChildEnv {
  const env: Record<string, string> = {};
  for (const source of [daemonEnv, adapterEnv, requestEnv]) {
    for (const [name, value] of Object.entries(source)) if (value !== undefined) env[name] = value;
  }
  for (const name of DAEMON_ONLY_ENV_NAMES) delete env[name];
  env.PATH = environment.path;
  return env as ChildEnv;
}
