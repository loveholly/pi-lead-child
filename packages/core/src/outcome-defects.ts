// 宿主登记 outcome 时发现的缺陷。store 的 run gate 和 runtime 的失败分类都用这两条规则，
// 所以它们放在 core，runtime 不需要依赖 store。
export function isOutcomeNormalizeError(error: unknown): boolean {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "";
  const first = message.split(/\r?\n/)[0]?.replace(/^Error:\s*/, "") ?? "";
  // 信封不是对象也是无效信封：错在 agent 交上来的内容，不在宿主代码。
  return first.startsWith("outcome.") || first.startsWith("outcome is missing")
    || first === "outcome must be an object";
}

export function isHostOutcomeRegistrationDefect(input: {
  errorCode?: string | null;
  errorMessage?: string | null;
  blockerCode?: string | null;
}): boolean {
  if (input.blockerCode === "invalid_outcome_envelope") return true;
  return isOutcomeNormalizeError(input.errorMessage);
}
