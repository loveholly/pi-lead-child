// @pi-lead-child/runtime/testing：给其他包的测试用的替身和工具，不进生产代码。
import { fileURLToPath } from "node:url";

export * from "./replay-runtime.js";
export * from "./process-leaks.js";

// 真实 CLI 输出的失败样本（工单 02）。adapter 合约测试、daemon 测试和验收脚本共用这一份。
export const RUNTIME_FAILURES_FIXTURE = fileURLToPath(new URL("./fixtures/runtime-failures.json", import.meta.url));
