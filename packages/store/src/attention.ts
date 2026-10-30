export { isHostOutcomeRegistrationDefect } from "@pi-lead-child/core";

export type AttentionIntervention = "none" | "digest" | "inform" | "propose";

export const USER_SAFE_BLOCKED_NEXT_STEP = "请确认下一步；不要在同一缺陷上再次派发。";

export function isLeadInternalNextStep(text: string | null | undefined): boolean {
  const value = text?.trim() ?? "";
  if (!value) return false;
  return /Lead\s*应/.test(value)
    || /Lead should/i.test(value)
    || /call recover_ticket_run/i.test(value)
    || /call register_run_outcome/i.test(value)
    || /call spawn_child/i.test(value);
}

export function stripDiagnosticStack(text: string): string {
  const lines = text.split(/\r?\n/);
  const stackStart = lines.findIndex((line, index) => index > 0 && /^\s+at\s+/.test(line));
  const cut = stackStart === -1 ? lines : lines.slice(0, stackStart);
  return cut.join("\n").trim();
}

export function userFacingNextStep(nextStep: string | null | undefined): string | null {
  const value = nextStep?.trim() ?? "";
  if (!value || isLeadInternalNextStep(value)) return null;
  return value;
}

export function presentUserFacingCheckpoint(input: {
  kind: string;
  title: string;
  summary: string;
  nextStep: string | null;
}): { title: string; summary: string; nextStep: string | null } {
  const title = stripDiagnosticStack(input.title).slice(0, 160) || input.title;
  const summary = stripDiagnosticStack(input.summary).slice(0, 2_000) || input.summary;
  let nextStep = userFacingNextStep(input.nextStep);
  if (input.kind === "blocked" && !nextStep) nextStep = USER_SAFE_BLOCKED_NEXT_STEP;
  return { title, summary, nextStep };
}
