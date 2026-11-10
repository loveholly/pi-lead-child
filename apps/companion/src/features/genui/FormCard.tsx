import {
  Box, Button, Column, Icon, Popover, RecordRow, Row, SegmentedControl, Switch, Text, TextField,
} from '@pi-lead-child/components';
import {
  UI_FORM_SEGMENTED_MAX, initialUiFormValue, resolveUiFormSubmission,
  type UiFormDto, type UiFormField, type UiFormValue,
} from '@pi-lead-child/protocol';
import { useEffect, useRef, useState } from 'react';

import { useLocale, useMessages } from '@/i18n';

import { useCompanionRuntime } from '../../state/CompanionStateProvider';
import { useConnectionState, useLeadName } from '../../state/hooks';
import { formMessages } from './form.messages';

// 会话卡片里的表单（genui 的 Form，工单 #285，protocol 的 ui-forms.ts）。通用模式「决定」（P9.1）：标题、字段、操作组；
// 提交成功以后收成一行结束行（P9.4）。
//   - 值只在这个组件的 state 里：不进 store、localStorage、草稿。提交以后清掉敏感字段（成功、失败都清）。
//   - 校验用和 daemon 同一个函数（resolveUiFormSubmission）。第一次点提交以前不报错；之后边改边校验。
//     不合格的字段的标签变成红色，原因写在操作组左边那一行里（那一行总在，所以报错时卡片不变高，P1.3）。
//   - 提交走 POST /v1/forms/:form/submit：daemon 只认 render_ui 建的表单记录，以你本人的身份执行（和设置页同一个函数）。
//   - 表单的状态（还没交、上次失败、已经成功）从 GET /v1/forms/:form 读。读到以前画一行占位，和结束行同高（P1.5）。

export type FormProps = {
  id: string;
  target: { type: string; id: string | number };
  action: string;
  title?: string;
  description?: string;
  submitLabel?: string;
  fields: UiFormField[];
  form?: string;
  partial?: boolean;
};

type Values = Record<string, UiFormValue | undefined>;

const initialValues = (fields: readonly UiFormField[]): Values =>
  Object.fromEntries(fields.map((field) => [field.param, initialUiFormValue(field)]));

const withoutSecrets = (fields: readonly UiFormField[], values: Values): Values =>
  Object.fromEntries(Object.entries(values).map(([param, value]) => [param, fields.find((field) => field.param === param)?.kind === 'secret' ? '' : value]));

export function FormCard({ id, title, description, submitLabel, fields, form, partial = false }: FormProps) {
  const runtime = useCompanionRuntime();
  const locale = useLocale();
  const m = useMessages(formMessages);
  const connected = useConnectionState() === 'connected';
  const [state, setState] = useState<UiFormDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Values>(() => initialValues(fields));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  useEffect(() => {
    if (!form || partial) return undefined;
    let current = true;
    runtime.getUiForm(form).then(
      (dto) => { if (current) setState(dto); },
      (error: unknown) => { if (current) setLoadError(error instanceof Error ? error.message : m.unknownForm); },
    );
    return () => { current = false; };
  }, [form, partial, runtime, m.unknownForm]);

  if (state?.state === 'done') return <FormDoneRow id={id} title={title ?? m.done} result={state.result} />;
  if (form && !partial && !state && !loadError) {
    // 和结束行同高（主题 11.5 的 42）。
    return <Row testID={`surface-form-${id}-loading`} h={42} items="center"><Text size="meta" tone="secondary">{m.loading}</Text></Row>;
  }

  const checked = resolveUiFormSubmission(fields, values, locale);
  const errors = !checked.ok ? checked.errors : {};
  const firstError = tried ? fields.map((field) => errors[field.param]).find(Boolean) ?? null : null;
  const failure = state?.state === 'failed' && state.result ? m.failed(state.result.message) : null;
  const status = !form ? m.noForm
    : loadError ? loadError
    : requestError ?? firstError ?? failure;
  const statusIsError = status !== null;
  const disabled = partial || !form || busy || !connected;

  const submit = async () => {
    setTried(true);
    if (!checked.ok || !form) return;
    setBusy(true);
    setRequestError(null);
    // 提交的是这一刻的值；请求发出以后，敏感值马上从 state 里清掉。
    const sent = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
    setValues((previous) => withoutSecrets(fields, previous));
    try {
      const dto = await runtime.submitUiForm(form, sent);
      if (live.current) setState(dto);
    } catch (error) {
      if (live.current) setRequestError(error instanceof Error ? error.message : m.requestFailed);
    } finally {
      if (live.current) setBusy(false);
    }
  };

  return (
    <Column testID={`surface-form-${id}`} gap="card-row">
      {title || description ? (
        <Column gap="text-stack">
          {title ? <Text size="card-title" weight="semibold">{title}</Text> : null}
          {description ? <Text size="secondary" tone="secondary">{description}</Text> : null}
        </Column>
      ) : null}
      <Column gap="form-field">
        {fields.map((field) => (
          <FormFieldView
            key={field.param}
            formId={id}
            field={field}
            value={values[field.param]}
            invalid={tried && Boolean(errors[field.param])}
            disabled={disabled || Boolean(field.readOnly)}
            onChange={(value) => {
              setRequestError(null);
              setValues((previous) => ({ ...previous, [field.param]: value }));
            }}
          />
        ))}
      </Column>
      <Row gap="actions" items="center" borderTopWidth={1} borderTopColor="border-soft" pt="card-row">
        <Text
          testID={`surface-form-${id}-status`}
          flex={1}
          minW={0}
          size="note"
          tone={statusIsError ? 'danger-dark' : 'secondary'}
          numberOfLines={2}
        >
          {status ?? (fields.some((field) => field.required) ? m.requiredHint : ' ')}
        </Text>
        <Button
          testID={`surface-form-${id}-submit`}
          label={busy ? m.submitting : submitLabel ?? m.submit}
          size="sm"
          variant="solid"
          tone="accent"
          disabled={disabled}
          onPress={() => void submit()}
        />
      </Row>
    </Column>
  );
}

// 提交成功以后的结束行（P9.4，主题 11.5）：状态图标和状态词、对象、一句结果、时间。一行，高 42。
function FormDoneRow({ id, title, result }: { id: string; title: string; result: UiFormDto['result'] }) {
  const m = useMessages(formMessages);
  const at = result ? new Date(result.at) : null;
  const time = at && !Number.isNaN(at.getTime())
    ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : null;
  return (
    <Row testID={`surface-form-${id}-done`} h={42} items="center" gap="inline-item" minW={0}>
      <Icon name="check" size={16} color="success-dark" />
      <Text size="label" weight="semibold" tone="success-dark">{m.done}</Text>
      <Text size="label" weight="semibold" numberOfLines={1} shrink={0}>{title}</Text>
      <Text testID={`surface-form-${id}-result`} flex={1} minW={0} size="secondary" tone="strong" numberOfLines={1}>{result?.message ?? ''}</Text>
      {time ? <Text size="meta" tone="secondary" mono>{time}</Text> : null}
    </Row>
  );
}

function FormFieldView({ formId, field, value, invalid, disabled, onChange }: {
  formId: string; field: UiFormField; value: UiFormValue | undefined; invalid: boolean; disabled: boolean;
  onChange: (value: UiFormValue | undefined) => void;
}) {
  const m = useMessages(formMessages);
  const leadName = useLeadName();
  const testID = `surface-form-${formId}-field-${field.param}`;
  const help = field.kind === 'secret' ? [field.help, m.secretNote(leadName)].filter(Boolean).join(' ') : field.help;
  return (
    <Column testID={testID} gap="field">
      <Text size="label" weight="bold" tone={invalid ? 'danger-dark' : 'secondary'}>
        {field.label}{field.required && !(field.kind === 'secret' && field.keep) ? ' *' : ''}
      </Text>
      <FieldControl field={field} value={value} disabled={disabled} onChange={onChange} testID={`${testID}-input`} />
      {help ? <Text size="note" tone="muted">{help}</Text> : null}
    </Column>
  );
}

function FieldControl({ field, value, disabled, onChange, testID }: {
  field: UiFormField; value: UiFormValue | undefined; disabled: boolean; onChange: (value: UiFormValue | undefined) => void; testID: string;
}) {
  const m = useMessages(formMessages);
  const [reveal, setReveal] = useState(false);
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  switch (field.kind) {
    case 'text':
    case 'textarea':
      return (
        <TextField
          testID={testID}
          value={text}
          onChangeText={onChange}
          placeholder={field.placeholder}
          variant="filled"
          size="sm"
          disabled={disabled}
          multiline={field.kind === 'textarea'}
          // 多行输入框的高度和设置页的多行框一样（LeadProfileSection）。
          {...(field.kind === 'textarea' ? { height: 112 } : {})}
          mono={field.validate?.format === 'url'}
          keyboardType={field.validate?.format === 'url' ? 'url' : field.validate?.format === 'email' ? 'email-address' : 'default'}
          autoCapitalize={field.validate?.format ? 'none' : undefined}
          autoCorrect={field.validate?.format ? false : undefined}
          accessibilityLabel={field.label}
        />
      );
    case 'secret':
      return (
        <Row gap="inline-item" items="center">
          <TextField
            testID={testID}
            value={text}
            onChangeText={onChange}
            placeholder={field.keep ? m.keepPlaceholder : field.placeholder ?? m.secretPlaceholder}
            variant="filled"
            size="sm"
            grow
            mono
            disabled={disabled}
            secure={!reveal}
            // 和设置页填 key 的框一样：不让浏览器把存的密码填进来。
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={field.label}
          />
          <Button
            testID={`${testID}-reveal`}
            label={reveal ? m.hide : m.show}
            size="xs"
            variant="ghost"
            tone="neutral"
            disabled={disabled}
            onPress={() => setReveal((shown) => !shown)}
          />
        </Row>
      );
    case 'number':
      return (
        <TextField
          testID={testID}
          value={text}
          onChangeText={(next) => {
            const trimmed = next.trim();
            if (!trimmed) onChange(undefined);
            else {
              const parsed = Number(trimmed);
              // 写到一半（例如「1.」「-」）时保留原文，校验会说不是数字。
              onChange(Number.isFinite(parsed) && String(parsed) === trimmed ? parsed : trimmed);
            }
          }}
          placeholder={field.placeholder}
          variant="filled"
          size="sm"
          mono
          disabled={disabled}
          keyboardType={field.validate?.integer ? 'number-pad' : 'default'}
          accessibilityLabel={field.label}
        />
      );
    case 'switch':
      return (
        <Switch testID={testID} value={value === true} label={value === true ? m.yes : m.no} disabled={disabled} onValueChange={onChange} />
      );
    case 'select': {
      const options = field.options ?? [];
      if (field.display === 'segmented' && options.length <= UI_FORM_SEGMENTED_MAX) {
        return (
          <SegmentedControl
            testID={testID}
            size="sm"
            options={options.map((option) => ({ value: option.value, label: option.label }))}
            value={typeof value === 'string' ? value : ''}
            onChange={(next) => { if (!disabled) onChange(next); }}
            optionTestID={(next) => `${testID}-${next}`}
          />
        );
      }
      const selected = options.find((option) => option.value === value);
      if (disabled) {
        return <TextField testID={testID} value={selected?.label ?? ''} onChangeText={() => {}} variant="filled" size="sm" disabled />;
      }
      return (
        <Popover
          testID={testID}
          label={field.label}
          title={field.label}
          width={320}
          trigger={(
            // 和 sm 的输入框同高（TextField.shared 的 sm 是 32）。
            <Row items="center" gap="inline-item" px="inset-x" h={32} rounded="md" bg="surface-subtle" borderWidth={1} borderColor="border">
              <Text flex={1} minW={0} size="body" tone={selected ? 'default' : 'muted'} numberOfLines={1}>{selected?.label ?? m.choose}</Text>
              <Icon name="chevron-down" size={14} color="text-secondary" />
            </Row>
          )}
        >
          {(close) => (
            <Column>
              {options.map((option, index) => (
                <RecordRow
                  key={option.value}
                  testID={`${testID}-${option.value}`}
                  divider={index > 0}
                  title={option.label}
                  trailing={option.value === value ? <Icon name="check" size={16} color="accent" /> : undefined}
                  onPress={() => { close(); onChange(option.value); }}
                />
              ))}
            </Column>
          )}
        </Popover>
      );
    }
    case 'multiselect': {
      const picked = Array.isArray(value) ? value : [];
      return (
        <Row testID={testID} role="group" aria-label={field.label} flexWrap="wrap" gap="chips">
          {(field.options ?? []).map((option) => {
            const on = picked.includes(option.value);
            return (
              <Box key={option.value}>
                <Button
                  testID={`${testID}-${option.value}`}
                  label={option.label}
                  size="xs"
                  shape="pill"
                  variant={on ? 'soft' : 'outline'}
                  tone={on ? 'accent' : 'neutral'}
                  icon={on ? 'check' : undefined}
                  disabled={disabled}
                  accessibilityLabel={`${field.label}: ${option.label}`}
                  onPress={() => onChange(on ? picked.filter((entry) => entry !== option.value) : [...picked, option.value])}
                />
              </Box>
            );
          })}
        </Row>
      );
    }
  }
}

