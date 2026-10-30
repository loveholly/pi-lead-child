import { Box, Button, Card, Column, Icon, Row, Text, TextField, type ColorToken, type TextTone } from '@pi-lead-child/components';
import { useState } from 'react';

import type { InterventionActionId, InterventionPresentation } from '@/features/workspace/model';
import type { InterventionCommandState } from '@/state/types';

type InterventionPanelProps = {
  intervention: InterventionPresentation;
  commandState?: InterventionCommandState;
  onResolve?: (interventionId: string, actionId: InterventionActionId, customResponse?: string) => void;
};

type PanelTone = 'pending' | 'success' | 'danger' | 'muted' | 'neutral';

const PANEL: Record<PanelTone, { bg: ColorToken; border: ColorToken; iconBg: ColorToken; text: TextTone }> = {
  pending: { bg: 'danger-cream', border: 'danger-line', iconBg: 'danger-soft', text: 'danger-dark' },
  danger: { bg: 'danger-cream', border: 'danger-line', iconBg: 'danger-soft', text: 'danger-dark' },
  success: { bg: 'success-wash', border: 'success-line', iconBg: 'success-soft', text: 'success-dark' },
  muted: { bg: 'surface-subtle', border: 'border', iconBg: 'surface-muted', text: 'secondary' },
  neutral: { bg: 'surface', border: 'border', iconBg: 'surface-muted', text: 'default' },
};

// 工单详情里的介入面板：状态、提示、结论和可执行的操作。"自定义"操作展开一个输入框。
export function InterventionPanel({ intervention, commandState, onResolve }: InterventionPanelProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customResponse, setCustomResponse] = useState('');
  const pending = intervention.state === 'pending';
  const success = intervention.tone === 'success';
  const danger = intervention.tone === 'danger';
  const submitting = commandState?.state === 'pending';
  const commandLocked = submitting || commandState?.state === 'succeeded';
  const tone: PanelTone = pending ? 'pending' : success ? 'success' : danger ? 'danger' : intervention.tone === 'muted' ? 'muted' : 'neutral';
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
            name={pending || danger ? 'exclamation' : success ? 'check' : 'clock'}
            color={pending || danger ? 'danger-dark' : success ? 'success-dark' : 'text-secondary'}
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
        <Text mt="card-row" size="secondary" weight="medium" tone="success-dark">操作已提交，正在同步权威状态。</Text>
      ) : null}
      {pending && intervention.actions.length === 0 ? (
        <Text mt="card-row" size="secondary" tone="muted">当前绑定没有响应权限，请在具备 approvals:respond 的 channel 处理。</Text>
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
            placeholder="补充明确决定与下一步"
          />
          <Row justify="flex-end" gap="actions">
            <Button testID="intervention-custom-cancel" label="取消" variant="outline" tone="neutral" onPress={closeCustom} />
            <Button
              testID="intervention-custom-submit"
              label="提交决定"
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
