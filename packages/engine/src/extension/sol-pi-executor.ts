// pi 执行器的 SoL-Pi 入口：pi CLI 用 -e 加载本文件（runtime 的 pi.ts）。见 sol-pi.ts。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSolPi } from "./sol-pi.js";

export default async function (pi: ExtensionAPI): Promise<void> {
  await registerSolPi(pi, "executor");
}
