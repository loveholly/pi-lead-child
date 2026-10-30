import { Type, type Static } from "typebox";

export const KernelRuntimeIdSchema = Type.Union([
  Type.Literal("pi"), Type.Literal("codex"), Type.Literal("claude"),
]);
export type KernelRuntimeId = Static<typeof KernelRuntimeIdSchema>;

export const KERNEL_RUNTIME_IDS: readonly KernelRuntimeId[] = ["pi", "codex", "claude"];
