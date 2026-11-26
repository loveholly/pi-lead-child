import { Box, Button, Card, Column, Icon, Row, Text, TextField, type ColorToken, type TextTone } from '@pi-lead-child/components';
import { useState } from 'react';

import type { InterventionActionId, InterventionPresentation } from '@/features/workspace/model';
import { useMessages } from '@/i18n';
import type { InterventionCommandState } from '@/state/types';

import { ticketRecordsMessages } from './ticketRecords.messages';

type InterventionPanelProps = {
  intervention: InterventionPresentation;
  commandState?: InterventionCommandState;
  onResolve?: (interventionId: string, actionId: InterventionActionId, customResponse?: string) => void;
};

type PanelTone = 'pending' | 'info' | 'success' | 'danger' | 'muted' | 'neutral';

const PANEL: Record<PanelTone, { bg: ColorToken; border: ColorToken; iconBg: ColorToken; text: TextTone }> = {
  pending: { bg: 'danger-cream', border: 'danger-line', iconBg: 'danger-soft', text: 'danger-dark' },
  danger: { bg: 'danger-cream', border: 'danger-line', iconBg: 'danger-soft', text: 'danger-dark' },
  // 先交给 Lead、还没摆给你的决定（#561）：和外面的「Lead 处理中」一样，是「进行中」的颜色（主题 C-12）。
  info: { bg: 'surface', border: 'border', iconBg: 'accent-soft', text: 'accent' },
  success: { bg: 'success-wash', border: 'success-line', iconBg: 'success-soft', text: 'success-dark' },
  muted: { bg: 'surface-subtle', border: 'border', iconBg: 'surface-muted', text: 'secondary' },
  neutral: { bg: 'surface', border: 'border', iconBg: 'surface-muted', text: 'default' },
};

// 工单详情里的介入面板：状态、提示、结论和可执行的操作。"自定义"操作展开一个输入框。
export function InterventionPanel({ intervention, commandState, onResolve }: InterventionPanelProps) {
  const messages = useMessages(ticketRecordsMessages);
  const m = messages.intervention;
  const [customOpen, setCustomOpen] = useState(false);
  const [customResponse, setCustomResponse] = useState('');
  const pending = intervention.state === 'pending';
  const info = intervention.tone === 'info';
  const success = intervention.tone === 'success';
  const danger = intervention.tone === 'danger';
  const submitting = commandState?.state === 'pending';
  const commandLocked = submitting || commandState?.state === 'succeeded';
  const tone: PanelTone = info ? 'info' : pending ? 'pending' : success ? 'success' : danger ? 'danger' : intervention.tone === 'muted' ? 'muted' : 'neutral';
  const colors = PANEL[tone];
  const closeCustom = () => {
    setCustomOpen(false);
    setCustomResponse('');
  };
  return (
    <Card mt="card-row" p="card" rounded="xl" bg={colors.bg} borderColor={colors.border}>
      <Row items="center" gap="side-item">
        <Box w={22} h={22} rounded="full" items="center" justify="center" bg={colors.iconBg}>
          <Icon
            name={info ? 'clock' : pending || danger ? 'exclamation' : success ? 'check' : 'clock'}
            color={info ? 'accent-strong' : pending || danger ? 'danger-dark' : success ? 'success-dark' : 'text-secondary'}
            size={12}
            weight="bold"
          />
        </Box>
        <Text size="label" weight="extrabold" tone={colors.text}>{intervention.stateLabel}</Text>
      </Row>
      {intervention.prompt ? <Text mt="card-row" size="body">{intervention.prompt}</Text> : null}
      {intervention.resolutionText ? <Text mt="card-row" size="secondary" weight="bold" tone="success-dark">{intervention.resolutionText}</Text> : null}
      {commandState?.state === 'error' && commandState.error ? (
        <Text role="alert" mt="card-row" size="secondary" weight="medium" tone="danger-dark">{commandState.error}</Text>
      ) : null}
      {commandState?.state === 'succeeded' && pending ? (
        <Text mt="card-row" size="secondary" weight="medium" tone="success-dark">{m.submitted}</Text>
      ) : null}
      {pending && intervention.actions.length === 0 ? (
        <Text mt="card-row" size="secondary" tone="muted">{m.noPermission}</Text>
      ) : null}
      {intervention.actions.length > 0 ? (
        <Row flexWrap="wrap" gap="actions" mt="card-section">
          {intervention.actions.map((action) => (
            <Button
              key={action.id}
              testID={`intervention-action-${action.id}`}
              disabled={!onResolve || commandLocked}
              label={action.label}
              variant={action.tone === 'primary' ? 'solid' : 'outline'}
              tone={action.tone === 'danger' ? 'danger' : action.tone === 'primary' ? 'accent' : 'neutral'}
              onPress={() => {
                if (action.id === 'custom') setCustomOpen(true);
                else onResolve?.(intervention.id, action.id);
              }}
            />
          ))}
        </Row>
      ) : null}
      {intervention.note ? <Text mt="card-row" size="secondary" tone="secondary">{intervention.note}</Text> : null}
      {customOpen ? (
        <Column gap="card-row" mt="card-row">
          <TextField
            testID="intervention-custom-response"
            autoFocus
            multiline
            height={82}
            size="sm"
            fontSize="12"
            value={customResponse}
            onChangeText={setCustomResponse}
            placeholder={m.customPlaceholder}
          />
          <Row justify="flex-end" gap="actions">
            <Button testID="intervention-custom-cancel" label={messages.cancel} variant="outline" tone="neutral" onPress={closeCustom} />
            <Button
              testID="intervention-custom-submit"
              label={m.submit}
              disabled={!customResponse.trim() || !onResolve || commandLocked}
              onPress={() => {
                onResolve?.(intervention.id, 'custom', customResponse);
                closeCustom();
              }}
            />
          </Row>
        </Column>
      ) : null}
    </Card>
  );
}
