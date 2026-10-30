import {
  Box, ChatInput, Column, IconButton, ImageThumbnail, Row, SegmentedControl, Spacer, Text,
} from '@pi-lead-child/components';
import {
  CHAT_IMAGE_MAX_COUNT, CHAT_IMAGES_MAX_TOTAL_BASE64_LENGTH, type ChatImageInput, type ChatPlacement,
} from '@pi-lead-child/protocol';
import { useState, type ReactNode } from 'react';

import { canPickImages, ChatImageError, pickImageFiles, prepareChatImage, type ComposerImage } from '@/data/chatImagePicker';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';

type MessageComposerProps = {
  contextKey: string;
  placeholder: string;
  // images：随消息发的图片（只有给了 attachImages 的输入框才会有）。
  onSend: (message: string, images: ChatImageInput[]) => void;
  compact?: boolean;
  // 工单对话坞里的输入框：一行，只有文字和发送按钮。
  minimal?: boolean;
  disabled?: boolean;
  // 能不能带图片：Lead 的会话，daemon 也收图片（CHAT_IMAGES_CAPABILITY）。这个平台还不能选图片时（canPickImages）也没有「+」。
  attachImages?: boolean;
  // 工具栏右边、发送按钮前面的模型选择（Lead 的会话：LeadModelPicker，写着模型 id 和推理强度）。
  modelControl?: ReactNode;
  // Lead 正忙时，这条消息插话还是排队（工单 04，spec D6）。给出时，输入框上面多一个选择。
  placement?: { value: ChatPlacement; onChange: (value: ChatPlacement) => void };
  // 那一行右边的状态（工单 10：Lead 忙时排着的外部消息，LeadQueueBar）。只和 placement 一起出现，不让那一行变高。
  placementStatus?: ReactNode;
  // 输入卡片上半截的状态栏（主题 11.13，2026-10-28）：排着的事。row 是卡片里的那一行；drawer 是展开时从这一行
  // 往上长出来的列表，盖在会话上，不推动会话。展开时卡片上面两个角变成直角，和列表接成一块。
  tray?: ComposerTray | null;
};

export type ComposerTray = { row: ReactNode; drawer: ReactNode; open: boolean };

const PLACEMENT_OPTIONS = [
  { value: 'steer', label: '插话' },
  { value: 'followUp', label: '排队' },
] as const;

export function MessageComposer(props: MessageComposerProps) {
  const field = <MessageComposerField key={`${props.contextKey}:${props.disabled ? 'disabled' : 'enabled'}`} {...props} />;
  if (!props.placement) return field;
  // 插话：在 Lead 当前这批工具调用之后加进这一轮。排队：Lead 答完这一轮再答，连着排队的几条一起答。
  return (
    <Column gap="field">
      <Row items="center" gap="inline-item">
        <SegmentedControl
          testID="composer-placement"
          optionTestID={(value) => `composer-placement-${value}`}
          size="sm"
          options={PLACEMENT_OPTIONS}
          value={props.placement.value}
          onChange={props.placement.onChange}
        />
        {props.placementStatus ? <Box flex={1} minW={0}>{props.placementStatus}</Box> : null}
      </Row>
      {field}
    </Column>
  );
}

// 消息输入框（2026-10-25，参考 Kimi）：一张白色圆角卡片。上面是待发的图片（64×64 的小图，可以删掉单张），
// 中间是文字（缺省一行高，内容多了自动长高），下面一行工具栏：左边「+」选图片，右边模型名和圆形的发送按钮。
// web 上 Enter 发送、Shift+Enter 换行；可以粘贴剪贴板里的图片。草稿按 contextKey 存在工作区里，失去焦点时保存（图片不存）。
function MessageComposerField({
  contextKey, placeholder, onSend, compact = false, minimal = false, disabled = false, attachImages = false, modelControl, tray,
}: MessageComposerProps) {
  const workspace = useCompanionRuntime().workspace;
  const [text, setText] = useState(() => workspace.getState().composerDraftByContext[contextKey] ?? '');
  // 待发的图片，和图片加不进来的原因（不是图片、太多、太大；下一次加图片、删图片或发送时清掉）。放在一起，用一次更新改。
  const [attachments, setAttachments] = useState<{ images: ComposerImage[]; notice: string | null }>(EMPTY_ATTACHMENTS);
  const { images, notice } = attachments;
  // 正在处理（读取、缩小）的图片张数：处理完之前不能发送。
  const [preparing, setPreparing] = useState(0);
  const canAttach = attachImages && canPickImages && !minimal;
  const ready = !disabled && preparing === 0 && (text.trim().length > 0 || images.length > 0);

  const send = () => {
    if (!ready) return;
    onSend(text.trim(), images.map(({ mimeType, data }) => ({ mimeType, data })));
    setText('');
    setAttachments(EMPTY_ATTACHMENTS);
    workspace.getState().clearComposerDraft(contextKey);
  };

  const addFiles = async (files: Blob[]) => {
    if (!canAttach || !files.length) return;
    setPreparing((count) => count + files.length);
    const results = await Promise.allSettled(files.map((file) => prepareChatImage(file)));
    setPreparing((count) => count - files.length);
    const prepared = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    const failed = failure ? (failure.reason instanceof ChatImageError ? failure.reason.message : '有图片没能加上') : null;
    setAttachments((current) => appendImages(current.images, prepared, failed));
  };

  const removeImage = (key: string) => {
    setAttachments((current) => ({ images: current.images.filter((image) => image.key !== key), notice: null }));
  };

  const input = (
    <ChatInput
      value={text}
      onChangeText={setText}
      placeholder={placeholder}
      disabled={disabled}
      onSubmit={send}
      {...(canAttach ? { onPasteFiles: (files: Blob[]) => void addFiles(files) } : {})}
      onBlur={() => workspace.getState().setComposerDraft(contextKey, text)}
      testID="composer-input"
    />
  );
  const sendButton = (
    <IconButton
      testID="send-message"
      icon="arrow-up"
      label="发送"
      variant="solid"
      // 没有可发的内容时是灰色（Kimi 的样式），有了变成主色。
      tone={ready ? 'accent' : 'neutral'}
      size={minimal ? 'sm' : 'md'}
      rounded="full"
      disabled={!ready}
      onPress={send}
    />
  );

  if (minimal) {
    // 工单对话坞：文字和发送按钮在一行，发送按钮贴着底边，文字长高时它留在最后一行旁边。
    return (
      <Row
        testID="composer"
        items="flex-end"
        gap="side-item"
        px="composer-x"
        py="composer-y"
        rounded="3xl"
        borderWidth={1}
        borderColor="border-input"
        bg="surface"
        opacity={disabled ? 0.62 : 1}
      >
        {/* spacing-exempt: 文字一行高 24，发送按钮 34，上下各留 5 让一行字和按钮居中对齐 */}
        <Box flex={1} minW={0} py={5}>{input}</Box>
        {sendButton}
      </Row>
    );
  }

  const body = (
    <Column gap="composer-row" px="composer-x" py="composer-y">
      {images.length ? (
        <Row testID="composer-images" flexWrap="wrap" gap="thumbnails">
          {images.map((image, index) => (
            <ImageThumbnail
              key={image.key}
              testID={`composer-image-${index}`}
              uri={image.uri}
              label={`图片 ${index + 1}`}
              removeLabel={`移除图片 ${index + 1}`}
              onRemove={() => removeImage(image.key)}
            />
          ))}
        </Row>
      ) : null}
      {notice ? <Text testID="composer-notice" size="note" tone="danger">{notice}</Text> : null}
      {input}
      <Row items="center" gap="inline-item">
        {canAttach ? (
          <IconButton
            testID="composer-attach"
            icon="plus"
            label="添加图片"
            variant="ghost"
            size="md"
            iconColor="text-secondary"
            disabled={disabled}
            onPress={() => void pickImageFiles().then(addFiles)}
          />
        ) : null}
        {preparing > 0 ? <Text testID="composer-preparing" size="note" tone="muted">正在处理图片…</Text> : null}
        <Spacer />
        {modelControl}
        {sendButton}
      </Row>
    </Column>
  );
  const open = Boolean(tray?.open);
  const card = (
    <Column
      testID="composer"
      rounded="4xl"
      {...(open ? { borderTopLeftRadius: 0, borderTopRightRadius: 0 } : {})}
      borderWidth={1}
      borderColor="border-input"
      bg="surface"
      boxShadow={compact ? '0 4px 14px rgba(16,24,40,0.06)' : '0 6px 20px rgba(16,24,40,0.08)'}
      opacity={disabled ? 0.62 : 1}
      overflow={tray ? 'hidden' : undefined}
    >
      {tray ? tray.row : null}
      {body}
    </Column>
  );
  // 展开的列表盖在会话上（P1、P2）：贴着卡片的上沿，宽度和卡片一样。
  // 外面这一层一直在：状态栏出现、消失时输入框不会重新挂载（不丢焦点，不丢正在打的字）。
  return (
    <Box position="relative">
      {tray ? tray.drawer : null}
      {card}
    </Box>
  );
}

const EMPTY_ATTACHMENTS: { images: ComposerImage[]; notice: string | null } = { images: [], notice: null };

// 加上新处理好的图片：最多 CHAT_IMAGE_MAX_COUNT 张，base64 加起来不超过上限，多出来的不加，提示一句。
function appendImages(
  current: readonly ComposerImage[], added: readonly ComposerImage[], failed: string | null,
): { images: ComposerImage[]; notice: string | null } {
  const images = [...current];
  let total = images.reduce((sum, image) => sum + image.data.length, 0);
  let dropped = false;
  for (const image of added) {
    if (images.length >= CHAT_IMAGE_MAX_COUNT || total + image.data.length > CHAT_IMAGES_MAX_TOTAL_BASE64_LENGTH) {
      dropped = true;
      continue;
    }
    images.push(image);
    total += image.data.length;
  }
  return { images, notice: dropped ? `一条消息最多带 ${CHAT_IMAGE_MAX_COUNT} 张图片，多出来的没有加上` : failed };
}
