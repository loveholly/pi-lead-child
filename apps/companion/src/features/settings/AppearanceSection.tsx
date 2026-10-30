import { Box, Button, Card, Column, Row, SegmentedControl, Text, TextField, type ColorToken } from '@pi-lead-child/components';
import {
  DENSITY_ZONE_LABELS, DENSITY_ZONES, DESIGN_NOTES_MAX_LENGTH, PALETTE_ROLE_LABELS, PALETTE_ROLES,
  designPreferencesFields, type DensityLevel, type DesignPreferencesDto, type LineHeightLevel, type RadiusLevel, type TextScaleLevel,
} from '@pi-lead-child/protocol';
import { useState, type ReactNode } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useDesignPreferences, useLeadName } from '@/state/hooks';

import {
  COLORS_HELP, DENSITY_HELP, DENSITY_OPTIONS, LINE_HEIGHT_OPTIONS, NOTES_HELP, NOTES_PLACEHOLDER, RADIUS_OPTIONS, TEXT_SCALE_OPTIONS,
  appearanceChanges, appearanceForm, appearanceFormProblem, appearanceResetRequest, appearanceUpdatedLine,
} from './appearanceModel';
import { memoryErrorText } from './memoryModel';
import { useServerForm } from './useServerForm';

// 设置 → 外观（2026-10-22）：密度、圆角、行高、字号、颜色和设计说明。
// 保存走 POST /v1/design/preferences；Lead 的 update_design_preferences 工具改的是同一份（engine 的 updateDesignPreferences）。
// 保存成功后 store 里的偏好立刻换成新值，整个界面随之重画。
export function AppearanceSection() {
  const { designPreferences, resource } = useDesignPreferences();
  if (!designPreferences) {
    return (
      <Text testID="appearance-loading" size="note" tone={resource?.state === 'error' ? 'danger-dark' : 'muted'}>
        {resource?.state === 'error'
          ? `读不到外观设置：${resource.error ? memoryErrorText(resource.error) : '这个设置还没有启动'}`
          : '正在读取外观设置…'}
      </Text>
    );
  }
  return <AppearanceFormCard preferences={designPreferences} />;
}

function AppearanceFormCard({ preferences }: { preferences: DesignPreferencesDto }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const saved = designPreferencesFields(preferences);
  const { form, field, setForm } = useServerForm(appearanceForm(saved));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const changes = appearanceChanges(form, saved);
  const reset = appearanceResetRequest(saved);
  const updated = appearanceUpdatedLine(preferences, leadName, new Date());

  const send = (request: NonNullable<typeof changes>, done: string) => {
    const problem = appearanceFormProblem(request);
    if (problem) {
      setMessage({ text: problem, error: true });
      return;
    }
    setSaving(true);
    setMessage(null);
    runtime.updateDesignPreferences(request)
      .then(() => setMessage({ text: done, error: false }))
      .catch((reason: unknown) => setMessage({ text: memoryErrorText(reason), error: true }))
      .finally(() => setSaving(false));
  };

  const choose = (name: string) => (value: string) => setForm((current) => ({ ...current, [name]: value }));

  return (
    <Column testID="appearance-section" gap="page-section">
      <Card rounded="xl" p="page-card" gap="form-field">
        <Field label="密度" help={DENSITY_HELP}>
          <Column gap="field">
            {DENSITY_ZONES.map((zone) => (
              <Row key={zone} items="center" gap="side-item" flexWrap="wrap">
                <Text size="label" tone="secondary" w={72}>{DENSITY_ZONE_LABELS[zone]}</Text>
                <Box w={240}>
                  <SegmentedControl<DensityLevel>
                    options={DENSITY_OPTIONS}
                    value={form[`density.${zone}`] as DensityLevel}
                    onChange={choose(`density.${zone}`)}
                    size="sm"
                    optionTestID={(value) => `appearance-density-${zone}-${value}`}
                  />
                </Box>
              </Row>
            ))}
          </Column>
        </Field>
        <Field label="圆角" help="卡片、按钮和输入框的圆角。">
          <SegmentedControl<RadiusLevel> options={RADIUS_OPTIONS} value={form.radius as RadiusLevel} onChange={choose('radius')} size="sm" optionTestID={(value) => `appearance-radius-${value}`} />
        </Field>
        <Field label="字号" help="所有文字一起变，最小 11 号。会话正文不受影响。">
          <SegmentedControl<TextScaleLevel> options={TEXT_SCALE_OPTIONS} value={form.textScale as TextScaleLevel} onChange={choose('textScale')} size="sm" optionTestID={(value) => `appearance-text-${value}`} />
        </Field>
        <Field label="行高" help="文字行与行之间的距离。">
          <SegmentedControl<LineHeightLevel> options={LINE_HEIGHT_OPTIONS} value={form.lineHeight as LineHeightLevel} onChange={choose('lineHeight')} size="sm" optionTestID={(value) => `appearance-leading-${value}`} />
        </Field>
        <Field label="颜色" help={COLORS_HELP}>
          <Column gap="field">
            {PALETTE_ROLES.map((role) => {
              const value = form[`colors.${role}`] ?? '';
              const valid = /^#[0-9a-fA-F]{6}$/.test(value.trim());
              return (
                <Row key={role} items="center" gap="side-item">
                  <Text size="label" tone="secondary" w={72}>{PALETTE_ROLE_LABELS[role]}</Text>
                  {/* 色块预览：用户填的十六进制值直接当底色。它不是 token，所以按 token 的类型断言一次；Tamagui 把它原样交给平台。 */}
                  <Box w={20} h={20} rounded="sm" borderWidth={1} borderColor="border" bg={(valid ? value.trim() : 'transparent') as ColorToken} />
                  <Box w={132}>
                    <TextField
                      testID={`appearance-color-${role}`}
                      value={value}
                      onChangeText={field(`colors.${role}`)}
                      variant="filled"
                      size="sm"
                      maxLength={7}
                      autoCapitalize="characters"
                      autoCorrect={false}
                    />
                  </Box>
                </Row>
              );
            })}
          </Column>
        </Field>
        <Field label="设计说明" help={NOTES_HELP}>
          <TextField
            testID="appearance-notes"
            value={form.notes ?? ''}
            onChangeText={field('notes')}
            placeholder={NOTES_PLACEHOLDER}
            variant="filled"
            size="sm"
            multiline
            height={112}
            maxLength={DESIGN_NOTES_MAX_LENGTH}
          />
        </Field>
        <Row items="center" gap="actions" flexWrap="wrap">
          <Button testID="appearance-save" label="保存" size="sm" disabled={saving || !changes} onPress={() => changes && send(changes, '已保存，界面已经按新的外观重画。')} />
          <Button testID="appearance-reset" label="恢复缺省" size="sm" variant="ghost" disabled={saving || !reset} onPress={() => reset && send(reset, '已恢复缺省的外观。设计说明保留。')} />
          {message ? (
            <Text testID="appearance-message" size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text>
          ) : null}
        </Row>
      </Card>
      {updated ? <Text testID="appearance-updated" size="label" tone="muted">{updated}</Text> : null}
    </Column>
  );
}

function Field({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <Column gap="field">
      <Text size="label" weight="bold" tone="secondary">{label}</Text>
      {children}
      <Text size="note" tone="muted">{help}</Text>
    </Column>
  );
}
