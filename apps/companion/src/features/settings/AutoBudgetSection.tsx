import { Button, Card, Column, Divider, Row, Text, TextField } from '@pi-lead-child/components';
import {
  AUTO_BUDGET_KEYS, AUTO_BUDGET_MAX, AUTO_BUDGET_SETTINGS_CAPABILITY,
  type AutoBudgetDto, type AutoBudgetKey, type AutoBudgetLimits, type SetAutoBudgetRequest,
} from '@pi-lead-child/protocol';
import { useState, type ReactNode } from 'react';

import { useLocale } from '@/i18n';
import { useCompanionRuntime, useControlPlaneStore } from '@/state/CompanionStateProvider';
import { useAutoBudget, useLeadName } from '@/state/hooks';

import { autoBudgetMessages } from './autoBudget.messages';
import { memoryErrorText } from './memoryModel';

// 设置 → Lead → 身份与风格 →「自动调用模型的上限」（工单 #553，主题 11.27；主人 2026-11-26 选了放在这一页）。
// 11.19 表单的写法：标题和一句说明，三个数字字段（每个字段下面写缺省值和最近的用量），分隔线下面是状态文字、「恢复缺省」和唯一的
// 主按钮「保存」。保存走操作层的 auto_budget.set（和 Lead 的 perform_action 同一个函数），只交改了的字段；daemon 写回 config.json，
// 马上生效。旧 daemon 没有宣布 lead.auto-budget-settings.v1 时只写一行说明。
export function AutoBudgetSection() {
  const supported = useControlPlaneStore((state) => state.capabilities.includes(AUTO_BUDGET_SETTINGS_CAPABILITY));
  const locale = useLocale();
  if (!supported) {
    return <Text testID="auto-budget-unsupported" size="note" tone="muted">{autoBudgetMessages(locale).unsupported}</Text>;
  }
  return <AutoBudgetCard />;
}

function AutoBudgetCard() {
  const { autoBudget, resource } = useAutoBudget();
  const locale = useLocale();
  const m = autoBudgetMessages(locale);
  if (!autoBudget) {
    return (
      <Text testID="auto-budget-loading" size="note" tone={resource?.state === 'error' ? 'danger-dark' : 'muted'}>
        {resource?.state === 'error' ? m.loadFailed(memoryErrorText(resource.error, locale)) : m.loading}
      </Text>
    );
  }
  // 保存着的上限变了（这台或别的设备改了）：表单从新的值重新开始。
  return <AutoBudgetForm key={AUTO_BUDGET_KEYS.map((key) => autoBudget.limits[key]).join('/')} saved={autoBudget} />;
}

type Form = Record<AutoBudgetKey, string>;
const formOf = (limits: AutoBudgetLimits): Form => ({
  callsPerHour: String(limits.callsPerHour), callsPerDay: String(limits.callsPerDay), uncachedTokensPerDay: String(limits.uncachedTokensPerDay),
});
const USAGE: Record<AutoBudgetKey, keyof AutoBudgetDto['usage']> = {
  callsPerHour: 'callsLastHour', callsPerDay: 'callsLastDay', uncachedTokensPerDay: 'uncachedTokensLastDay',
};

/** 表单的一个值：0 或更大的整数，不超过上限。不合格时返回原因的种类。 */
export function parseLimit(key: AutoBudgetKey, text: string): number | 'invalid' | 'too_large' {
  const trimmed = text.trim().replace(/[,\s]/g, '');
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return 'too_large';
  return value > AUTO_BUDGET_MAX[key] ? 'too_large' : value;
}

function AutoBudgetForm({ saved }: { saved: AutoBudgetDto }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = autoBudgetMessages(locale);
  const [form, setForm] = useState<Form>(() => formOf(saved.limits));
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  const parsed = AUTO_BUDGET_KEYS.map((key) => ({ key, value: parseLimit(key, form[key]) }));
  const firstBad = parsed.find((entry) => typeof entry.value !== 'number');
  const changes: SetAutoBudgetRequest = {};
  for (const { key, value } of parsed) if (typeof value === 'number' && value !== saved.limits[key]) changes[key] = value;
  const changed = Object.keys(changes).length > 0;
  const atDefaults = AUTO_BUDGET_KEYS.every((key) => parseLimit(key, form[key]) === saved.defaults[key]);

  const edit = (key: AutoBudgetKey) => (text: string) => {
    setForm((current) => ({ ...current, [key]: text }));
    setOutcome(null);
  };
  const save = () => {
    if (saving || firstBad || !changed) return;
    setSaving(true);
    setOutcome(null);
    runtime.setAutoBudget(changes)
      .then(() => setOutcome({ ok: true, text: m.saved }))
      .catch((reason: unknown) => setOutcome({ ok: false, text: m.failed(memoryErrorText(reason, locale)) }))
      .finally(() => setSaving(false));
  };

  // 状态文字总在（11.19 表单）：平时写怎么用；不合格时写第一个不合格字段的原因；保存中、保存后写结果。
  const status = saving ? { text: m.saving, tone: 'muted' as const }
    : firstBad ? {
      text: firstBad.value === 'too_large' ? m.tooLarge(m.labels[firstBad.key], AUTO_BUDGET_MAX[firstBad.key]) : m.invalid(m.labels[firstBad.key]),
      tone: 'danger-dark' as const,
    }
    : outcome ? { text: outcome.text, tone: outcome.ok ? 'success-dark' as const : 'danger-dark' as const }
    : { text: m.footnote(leadName), tone: 'muted' as const };

  return (
    <Card testID="auto-budget-section" rounded="xl" p="page-card" gap="form-field">
      <Column gap="text-stack">
        <Text size="card-title" weight="extrabold">{m.title}</Text>
        <Text size="note" tone="muted">{m.intro(leadName)}</Text>
      </Column>
      {AUTO_BUDGET_KEYS.map((key) => (
        <Field key={key} label={m.labels[key]} bad={typeof parseLimit(key, form[key]) !== 'number'}
          note={m.notes[key](saved.defaults[key], saved.usage[USAGE[key]])}>
          <TextField testID={`auto-budget-${key}`} value={form[key]} onChangeText={edit(key)} variant="filled" size="sm" mono
            keyboardType="number-pad" disabled={saving} accessibilityLabel={m.labels[key]} />
        </Field>
      ))}
      <Divider />
      {/* 换行的行里文字不写 flex（nativeFlexWrap.test.ts：Android 上会被挤成一个字宽）。按钮用 ml="auto" 推到行尾。 */}
      <Row items="center" gap="actions" flexWrap="wrap">
        <Text testID="auto-budget-status" size="note" tone={status.tone}>{status.text}</Text>
        <Row ml="auto" items="center" gap="actions">
          {atDefaults ? null : (
            <Button testID="auto-budget-defaults" label={m.restoreDefaults} variant="ghost" tone="neutral" size="sm" disabled={saving}
              onPress={() => { setForm(formOf(saved.defaults)); setOutcome(null); }} />
          )}
          <Button testID="auto-budget-save" label={saving ? m.saving : m.save} size="sm" disabled={saving || Boolean(firstBad) || !changed} onPress={save} />
        </Row>
      </Row>
    </Card>
  );
}

function Field({ label, note, bad, children }: { label: string; note: string; bad: boolean; children: ReactNode }) {
  return (
    <Column gap="field">
      <Text size="label" weight="bold" tone={bad ? 'danger-dark' : 'secondary'}>{label}</Text>
      {children}
      <Text size="note" tone="muted">{note}</Text>
    </Column>
  );
}
