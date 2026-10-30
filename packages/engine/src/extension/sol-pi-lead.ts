// Lead 的 SoL-Pi 入口：Lead 的 SDK 会话经 additionalExtensionPaths 加载本文件（lead 的 session.ts）。见 sol-pi.ts。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSolPi } from "./sol-pi.js";

export default async function (pi: ExtensionAPI): Promise<void> {
  await registerSolPi(pi, "lead");
}
