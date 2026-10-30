export const LEAD_MODEL_SWITCH_NOTICE_PREFIX = '【系统】';

export function splitMaintenanceNotice(text: string | null | undefined): {
  notice: string | null;
  remainder: string | null;
} {
  const value = text?.trim() ?? '';
  if (!value.startsWith(LEAD_MODEL_SWITCH_NOTICE_PREFIX) || !value.includes('切换')) {
    return { notice: null, remainder: null };
  }
  const [first = '', ...rest] = value.split('\n');
  return {
    notice: first.slice(LEAD_MODEL_SWITCH_NOTICE_PREFIX.length).trim(),
    remainder: rest.join('\n').trim(),
  };
}

export function maintenanceNoticeFor(text: string | null | undefined): string | null {
  return splitMaintenanceNotice(text).notice;
}
