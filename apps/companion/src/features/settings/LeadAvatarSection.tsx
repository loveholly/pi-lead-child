import { AvatarImage, Box, Button, Card, Column, LeadAvatar, Row, Text, TextField } from '@pi-lead-child/components';
import {
  LEAD_AVATAR_CAPABILITY, LEAD_AVATAR_SLOTS, normalizeSlackEmojiCode, SLACK_BYLINE_EMOJI_MAX_LENGTH,
  type LeadAvatarDto, type LeadAvatarSlot, type SlackEmojiPreview,
} from '@pi-lead-child/protocol';
import { useEffect, useState } from 'react';

import { leadAvatarSource } from '@/components/leadAvatarSource';
import { AvatarImageError, canPickAvatar, pickAvatarFile, prepareAvatarImage } from '@/data/avatarImagePicker';
import { useCompanionRuntime, useControlPlaneStore } from '@/state/CompanionStateProvider';
import { useLeadAvatar, useLeadName } from '@/state/hooks';

import {
  LEAD_AVATAR_FAIRY_EYE_NOTE, LEAD_AVATAR_SLOT_LABELS, LEAD_AVATAR_SLOT_LOOKS, SLACK_EMOJI_HELP, SLACK_EMOJI_INVALID,
  leadAvatarFootnote, leadAvatarSlotStatus, slackEmojiPreviewNote, slackEmojiSourceNote,
} from './leadAvatarModel';
import { memoryErrorText } from './memoryModel';

// 预览的格子：64 的图放在 80 的浅灰圆角底上（主题 11.15，组件规格）。
const PREVIEW_SIZE = 64;
const PREVIEW_WELL = 80;
// 格子最窄多宽：桌面上一行四个，手机上两行两列。
const TILE_MIN_WIDTH = 112;
// Slack 预览里 emoji 的大小（照 Slack 的上下文行）；预览行至少 40 高，和旁边的输入框齐。
const SLACK_EMOJI_SIZE = 16;
const SLACK_PREVIEW_MIN_HEIGHT = 40;
// Slack 一段的两栏最窄多宽：输入框 200、预览 220，桌面上并排，手机上上下排。
const SLACK_INPUT_MIN_WIDTH = 200;
const SLACK_PREVIEW_MIN_WIDTH = 220;
// 输入停顿多久以后查一次预览。
const PREVIEW_DELAY_MS = 300;

// 设置 → Lead → 身份与风格 → 形象（主题 11.12、11.15，用户 2026-10-28）：四种状态的图，和 Slack 署名的 emoji。
// 上传走 POST /v1/lead/avatar/slots/:slot；Lead 的 set_lead_avatar 工具改的是同一份（engine 的 lead-avatar.ts）。
// FairyEye 是隐藏开关：只有用户发 /fairyeye on 能打开，这里只在它开着时说一句怎么关。
export function LeadAvatarSection() {
  const { leadAvatar, images, resource } = useLeadAvatar();
  const supported = useControlPlaneStore((state) => state.capabilities.includes(LEAD_AVATAR_CAPABILITY));
  if (!supported) {
    return <Text testID="lead-avatar-unsupported" size="note" tone="muted">这个 daemon 还不能设置形象，更新以后再来。</Text>;
  }
  if (!leadAvatar) {
    return (
      <Text testID="lead-avatar-loading" size="note" tone={resource?.state === 'error' ? 'danger-dark' : 'muted'}>
        {resource?.state === 'error' ? `读不到形象：${resource.error ? memoryErrorText(resource.error) : '这个设置还没有启动'}` : '正在读取形象…'}
      </Text>
    );
  }
  return (
    <Card testID="lead-avatar-section" rounded="xl" p="page-card" gap="form-field">
      <Column gap="text-stack">
        <Text size="card-title" weight="extrabold">形象</Text>
        {leadAvatar.fairyEye ? (
          <Text testID="lead-avatar-fairy-eye-note" size="note" tone="secondary">{LEAD_AVATAR_FAIRY_EYE_NOTE}</Text>
        ) : null}
      </Column>
      <Row gap="side-item" flexWrap="wrap">
        {LEAD_AVATAR_SLOTS.map((slot) => <AvatarSlotTile key={slot} slot={slot} avatar={leadAvatar} images={images} />)}
      </Row>
      <Text size="note" tone="muted">{leadAvatarFootnote(canPickAvatar)}</Text>
      <Box borderTopWidth={1} borderColor="border-soft" />
      <SlackBylineEmojiField avatar={leadAvatar} />
    </Card>
  );
}

function AvatarSlotTile({ slot, avatar, images }: { slot: LeadAvatarSlot; avatar: LeadAvatarDto; images: Record<string, string> }) {
  const runtime = useCompanionRuntime();
  const name = useLeadName();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const look = LEAD_AVATAR_SLOT_LOOKS[slot];
  // 预览画的是素材：FairyEye 开着时，这里上传的图要等关掉以后才显示，但先给你看它的样子。
  const source = leadAvatarSource({ ...avatar, fairyEye: false }, images, look);
  const label = LEAD_AVATAR_SLOT_LABELS[slot];

  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    work()
      .catch((reason: unknown) => setError(reason instanceof AvatarImageError ? reason.message : memoryErrorText(reason)))
      .finally(() => setBusy(false));
  };
  const upload = () => run(async () => {
    const file = await pickAvatarFile();
    if (!file) return;
    await runtime.uploadLeadAvatarSlot(slot, await prepareAvatarImage(file));
  });
  const reset = () => run(() => runtime.clearLeadAvatarSlot(slot));

  return (
    <Column testID={`lead-avatar-slot-${slot}`} flex={1} minW={TILE_MIN_WIDTH} gap="card-row">
      <Box w={PREVIEW_WELL} h={PREVIEW_WELL} rounded="lg" bg="surface-muted" items="center" justify="center">
        <LeadAvatar
          testID={`lead-avatar-preview-${slot}`}
          source={source}
          size={PREVIEW_SIZE}
          name={name}
          state={look.state}
          tone={look.tone}
        />
      </Box>
      <Column gap="text-stack">
        <Text size="label" weight="bold">{label}</Text>
        <Text testID={`lead-avatar-status-${slot}`} size="meta" tone="secondary">{leadAvatarSlotStatus(avatar, slot)}</Text>
      </Column>
      <Row items="center" gap="inline-item" flexWrap="wrap">
        {canPickAvatar ? (
          <Button
            testID={`lead-avatar-upload-${slot}`}
            label="上传"
            accessibilityLabel={`上传${label}的图`}
            variant="outline"
            tone="neutral"
            size="xs"
            disabled={busy}
            onPress={upload}
          />
        ) : null}
        {avatar.slots[slot] ? (
          <Button
            testID={`lead-avatar-reset-${slot}`}
            label="恢复"
            accessibilityLabel={`${label}恢复成${slot === 'default' ? '系统素材' : '默认图'}`}
            variant="link"
            tone="neutral"
            size="xs"
            disabled={busy}
            onPress={reset}
          />
        ) : null}
      </Row>
      {error ? <Text testID={`lead-avatar-error-${slot}`} size="note" tone="danger-dark">{error}</Text> : null}
    </Column>
  );
}

function SlackBylineEmojiField({ avatar }: { avatar: LeadAvatarDto }) {
  const runtime = useCompanionRuntime();
  // 没动过输入框时跟着服务端的值走（别的设备或 Lead 改了以后跟着变）。
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const value = draft ?? avatar.slackEmoji;
  const code = normalizeSlackEmojiCode(value);
  const preview = useSlackEmojiPreview(value);
  const changed = code !== null && code !== avatar.slackEmoji;

  const save = (request: { emoji: string; reset?: boolean }) => {
    setSaving(true);
    setMessage(null);
    runtime.setLeadAvatarSlackEmoji(request)
      .then(() => {
        setDraft(null);
        setMessage({ text: '已保存。下一条发到 Slack 的消息就用它。', error: false });
      })
      .catch((reason: unknown) => setMessage({ text: memoryErrorText(reason), error: true }))
      .finally(() => setSaving(false));
  };

  return (
    <Column testID="slack-byline-emoji" gap="form-field">
      <Row gap="form-field" flexWrap="wrap" items="flex-start">
        <Column flex={1} minW={SLACK_INPUT_MIN_WIDTH} gap="field">
          <Text size="label" weight="bold" tone="secondary">Slack 署名 emoji</Text>
          <TextField
            testID="slack-byline-emoji-input"
            value={value}
            onChangeText={setDraft}
            placeholder=":robot_face:"
            variant="filled"
            size="sm"
            maxLength={SLACK_BYLINE_EMOJI_MAX_LENGTH}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text size="note" tone="muted">{SLACK_EMOJI_HELP}</Text>
        </Column>
        <Column flex={1} minW={SLACK_PREVIEW_MIN_WIDTH} gap="field">
          <Text size="label" weight="bold" tone="secondary">Slack 里的样子</Text>
          <SlackBylinePreview preview={preview} invalid={code === null} />
        </Column>
      </Row>
      <Row items="center" gap="field" flexWrap="wrap">
        <Button testID="slack-byline-emoji-save" label="保存" size="sm" disabled={saving || !changed} onPress={() => save({ emoji: code ?? '' })} />
        {avatar.slackEmojiSource === 'settings' ? (
          <Button
            testID="slack-byline-emoji-reset"
            label="恢复缺省"
            variant="link"
            tone="neutral"
            size="sm"
            disabled={saving}
            onPress={() => save({ emoji: '', reset: true })}
          />
        ) : null}
        <Text testID="slack-byline-emoji-message" size="note" tone={message?.error ? 'danger-dark' : 'secondary'}>
          {message?.text ?? slackEmojiSourceNote(avatar)}
        </Text>
      </Row>
    </Column>
  );
}

// 照 Slack 的上下文行画：16 的 emoji，后面是署名文字。没写 emoji 时只有文字；查不到图时照 Slack 的样子写短代码原文。
function SlackBylinePreview({ preview, invalid }: { preview: SlackEmojiPreview | null; invalid: boolean }) {
  if (invalid) return <Text testID="slack-byline-preview-note" size="note" tone="danger-dark">{SLACK_EMOJI_INVALID}</Text>;
  if (!preview) return <Text testID="slack-byline-preview-loading" size="note" tone="muted">正在生成预览…</Text>;
  const note = slackEmojiPreviewNote(preview);
  return (
    <Column gap="text-stack">
      <Row testID="slack-byline-preview" items="center" gap="icon-label" minH={SLACK_PREVIEW_MIN_HEIGHT} px="inset-x" rounded="md" bg="surface-subtle">
        {preview.status === 'custom' && preview.imageUrl ? (
          <AvatarImage testID="slack-byline-preview-emoji" uri={preview.imageUrl} size={SLACK_EMOJI_SIZE} label={preview.code} />
        ) : preview.code && preview.status !== 'none' ? (
          <Text testID="slack-byline-preview-code" size="meta" tone="secondary">{preview.code}</Text>
        ) : null}
        <Text testID="slack-byline-preview-text" size="meta" tone="secondary" numberOfLines={1}>{preview.byline}</Text>
      </Row>
      {note ? <Text testID="slack-byline-preview-note" size="note" tone="muted">{note}</Text> : null}
    </Column>
  );
}

// 输入停顿 300 毫秒后查一次 Slack 里的样子。写法不对时不查。新的结果到之前留着上一次的，预览不闪。
function useSlackEmojiPreview(value: string): SlackEmojiPreview | null {
  const runtime = useCompanionRuntime();
  const [preview, setPreview] = useState<SlackEmojiPreview | null>(null);
  const code = normalizeSlackEmojiCode(value);
  useEffect(() => {
    if (code === null) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      runtime.previewSlackEmoji(code, controller.signal)
        .then((next) => { if (!controller.signal.aborted) setPreview(next); })
        .catch(() => { /* 预览查不了：留着上一次的 */ });
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [code, runtime]);
  return preview;
}
