import { Button, Card, Column, Row, Text, TextField } from '@pi-lead-child/components';
import { DEFAULT_LEAD_NAME, LEAD_NAME_MAX_LENGTH, LEAD_PROFILE_TEXT_MAX_LENGTH, type LeadProfileDto } from '@pi-lead-child/protocol';
import { useState, type ReactNode } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useLeadProfile } from '@/state/hooks';

import {
  INTERACTION_STYLE_HELP, INTERACTION_STYLE_PLACEHOLDER, LEAD_NAME_HELP, PERSONA_HELP, PERSONA_PLACEHOLDER,
  leadProfileBoundaryNote, leadProfileChanges, leadProfileFormProblem, leadProfileUpdatedLine, type LeadProfileForm,
} from './leadProfileModel';
import { memoryErrorText } from './memoryModel';
import { useServerForm } from './useServerForm';

// 设置 → Lead → 身份与风格（2026-10-22）：名字、人格、你希望它怎样和你互动。
// 保存走 POST /v1/lead/profile；Lead 的 update_lead_profile 工具改的是同一份（engine 的 updateLeadProfile）。
export function LeadProfileSection() {
  const { leadProfile, resource } = useLeadProfile();
  if (!leadProfile) {
    return (
      <Text testID="lead-profile-loading" size="note" tone={resource?.state === 'error' ? 'danger-dark' : 'muted'}>
        {resource?.state === 'error'
          ? `读不到身份与风格：${resource.error ? memoryErrorText(resource.error) : '这个设置还没有启动'}`
          : '正在读取身份与风格…'}
      </Text>
    );
  }
  // 表单不按服务端的值加 key：别的设备或 Lead 改了以后，没动过的字段跟着变，正在写的留着。
  return <LeadProfileFormCard profile={leadProfile} />;
}

function LeadProfileFormCard({ profile }: { profile: LeadProfileDto }) {
  const runtime = useCompanionRuntime();
  const { form, field } = useServerForm<LeadProfileForm>({
    name: profile.name, persona: profile.persona, interactionStyle: profile.interactionStyle,
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const changes = leadProfileChanges(form, profile);
  const updated = leadProfileUpdatedLine(profile, new Date());

  const submit = () => {
    if (!changes) return;
    const problem = leadProfileFormProblem(changes);
    if (problem) {
      setMessage({ text: problem, error: true });
      return;
    }
    setSaving(true);
    setMessage(null);
    runtime.updateLeadProfile(changes)
      .then((next) => setMessage({ text: `已保存。${next.name} 从下一轮对话起按新的设置说话。`, error: false }))
      .catch((reason: unknown) => setMessage({ text: memoryErrorText(reason), error: true }))
      .finally(() => setSaving(false));
  };

  return (
    <Column testID="lead-profile-section" gap="page-section">
      <Card rounded="xl" p="page-card" gap="form-field">
        <Field label="名字" help={LEAD_NAME_HELP}>
          <TextField
            testID="lead-profile-name"
            value={form.name}
            onChangeText={field('name')}
            placeholder={DEFAULT_LEAD_NAME}
            variant="filled"
            size="sm"
            maxLength={LEAD_NAME_MAX_LENGTH}
            autoCapitalize="words"
            autoCorrect={false}
          />
        </Field>
        <Field label="人格" help={PERSONA_HELP}>
          <TextField
            testID="lead-profile-persona"
            value={form.persona}
            onChangeText={field('persona')}
            placeholder={PERSONA_PLACEHOLDER}
            variant="filled"
            size="sm"
            multiline
            height={112}
            maxLength={LEAD_PROFILE_TEXT_MAX_LENGTH}
          />
        </Field>
        <Field label="互动风格" help={INTERACTION_STYLE_HELP}>
          <TextField
            testID="lead-profile-style"
            value={form.interactionStyle}
            onChangeText={field('interactionStyle')}
            placeholder={INTERACTION_STYLE_PLACEHOLDER}
            variant="filled"
            size="sm"
            multiline
            height={112}
            maxLength={LEAD_PROFILE_TEXT_MAX_LENGTH}
          />
        </Field>
        <Text testID="lead-profile-boundary" size="note" tone="secondary">{leadProfileBoundaryNote(profile.name)}</Text>
        <Row items="center" gap="field" flexWrap="wrap">
          <Button testID="lead-profile-save" label="保存" size="sm" disabled={saving || !changes} onPress={submit} />
          {message ? (
            <Text testID="lead-profile-message" size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text>
          ) : null}
        </Row>
      </Card>
      {updated ? <Text testID="lead-profile-updated" size="label" tone="muted">{updated}</Text> : null}
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
