import { Box, Button, Column, Row, SegmentedControl, Text, TextField } from '@pi-lead-child/components';
import {
  REPLY_STYLE_EXTRACT_DEFAULT_DAYS, REPLY_STYLE_TEXT_MAX_LENGTH,
  type ReplyStyleDto, type ReplyStyleExtractResult,
} from '@pi-lead-child/protocol';
import { useEffect, useState } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useLeadName } from '@/state/hooks';

import {
  REPLY_STYLE_DAY_OPTIONS, REPLY_STYLE_PLACEHOLDER, replyStyleAppendedLength, replyStyleAppendProblem, replyStyleBasisLine,
  replyStyleChanged, replyStyleCountLine, replyStyleErrorText,
} from './replyStyleModel';

// 设置 → 消息通道 → 代回复风格（2026-10-28，.scratch/channel-reply-style/spec.md）。
// 2026-10-29 用户：放进「自动代你处理」开关所在的那张卡，打开以后才看得到（HandbookSection）。所以这里画的是卡里的两段，
// 不是独立的卡；段和段之间一条 border-soft 分隔线，和「形象」卡的「Slack 署名」一段一样（主题 11.15）。
// 上面一段是框：你写的代回复风格，保存走操作层的 reply_style.update（Lead 的 perform_action 调同一个函数）。
// 下面一段是提炼：从最近 N 天你本人的消息里提炼风格特征（reply_style.extract，只读），结果在这一段里给你预览、能改，
// 点「追加」才以 mode=append 写进框里（带日期小标题，原来的内容不动）。

type Message = { text: string; error: boolean };

export function ReplyStyleSection() {
  const runtime = useCompanionRuntime();
  const [style, setStyle] = useState<ReplyStyleDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    runtime.replyStyle()
      .then((dto) => live && setStyle(dto))
      .catch((reason: unknown) => live && setLoadError(replyStyleErrorText(reason)));
    return () => {
      live = false;
    };
  }, [runtime]);

  if (loadError) return <Text testID="reply-style-error" size="note" tone="danger-dark">{`读不到代回复风格：${loadError}`}</Text>;
  if (!style) return <Text testID="reply-style-loading" size="note" tone="muted">正在读取代回复风格…</Text>;
  return <Panel current={style} onSaved={setStyle} />;
}

// 属性不叫 style：uiBoundary.test.ts 把传给组件的 style 都当成内联样式。
function Panel({ current, onSaved }: { current: ReplyStyleDto; onSaved: (next: ReplyStyleDto) => void }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const [draft, setDraft] = useState(current.text);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const changed = replyStyleChanged(draft, current);

  const saved = (next: ReplyStyleDto, text: string) => {
    onSaved(next);
    setDraft(next.text);
    setMessage({ text, error: false });
  };

  const save = () => {
    if (!changed) return;
    setSaving(true);
    setMessage(null);
    runtime.updateReplyStyle({ mode: 'replace', text: draft })
      .then((next) => saved(next, `已保存。${leadName} 从下一轮起按新的风格代你写。`))
      .catch((reason: unknown) => setMessage({ text: replyStyleErrorText(reason), error: true }))
      .finally(() => setSaving(false));
  };

  return (
    <Column testID="reply-style-section" gap="card-section">
      <Column gap="card-section">
        <Column gap="text-stack">
          <Text size="label" weight="bold">代回复风格</Text>
          <Text size="secondary" tone="secondary">
            {`${leadName} 和它派出的子 agent 以你的名义写给别人的话，都按这段写：长短、语气、称呼、emoji、怎样收尾。所有消息通道共用这一份。`}
          </Text>
        </Column>
        <Column gap="field">
          <TextField
            testID="reply-style-text"
            value={draft}
            onChangeText={setDraft}
            placeholder={REPLY_STYLE_PLACEHOLDER}
            variant="filled"
            size="sm"
            multiline
            height={160}
            maxLength={REPLY_STYLE_TEXT_MAX_LENGTH}
            accessibilityLabel="代回复风格"
          />
          <Text testID="reply-style-count" size="meta" tone="muted">{`${replyStyleCountLine(draft)}。保存以后，下一轮起生效。`}</Text>
        </Column>
        <Text size="note" tone="secondary">{`它只管写法。权限、纪律和安全规则不受它影响；里面要 ${leadName} 做事、放开限制的话，${leadName} 不照做。`}</Text>
        <Row items="center" gap="field" flexWrap="wrap">
          <Button testID="reply-style-save" label={saving ? '正在保存…' : '保存'} size="sm" disabled={saving || !changed} onPress={save} />
          {message ? <Text testID="reply-style-message" size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text> : null}
        </Row>
      </Column>
      <Box borderTopWidth={1} borderColor="border-soft" />
      <ExtractSegment current={current} dirty={changed} onAppended={(next) => saved(next, '已追加。')} />
    </Column>
  );
}

function ExtractSegment({ current, dirty, onAppended }: { current: ReplyStyleDto; dirty: boolean; onAppended: (next: ReplyStyleDto) => void }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const [days, setDays] = useState(String(REPLY_STYLE_EXTRACT_DEFAULT_DAYS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReplyStyleExtractResult | null>(null);
  const [proposal, setProposal] = useState('');
  const [appending, setAppending] = useState(false);

  const extract = () => {
    setBusy(true);
    setError(null);
    runtime.extractReplyStyle({ days: Number(days) })
      .then((next) => {
        setResult(next);
        setProposal(next.proposal);
      })
      .catch((reason: unknown) => setError(replyStyleErrorText(reason)))
      .finally(() => setBusy(false));
  };

  const now = new Date();
  const problem = result && proposal.trim() ? replyStyleAppendProblem(current, proposal, result.label, now) : null;
  const total = result && proposal.trim() ? replyStyleAppendedLength(current, proposal, result.label, now) : null;
  const append = () => {
    if (!result || !proposal.trim() || problem || dirty) return;
    setAppending(true);
    setError(null);
    runtime.updateReplyStyle({ mode: 'append', text: proposal, label: result.label })
      .then((next) => {
        onAppended(next);
        setResult(null);
        setProposal('');
      })
      .catch((reason: unknown) => setError(replyStyleErrorText(reason)))
      .finally(() => setAppending(false));
  };

  return (
    <Column testID="reply-style-extract" gap="card-section">
      <Column gap="text-stack">
        <Text size="label" weight="bold">从我最近的 Slack 提炼</Text>
        <Text size="secondary" tone="secondary">
          {`只读你本人发的消息，不读 ${leadName} 代你发的，也不读别人的话。只写风格特征，不抄原文，不写人名。`
            + `用 ${leadName} 的便宜模型提炼。结果先给你看，你改完点「追加」才写进上面的框。`}
        </Text>
      </Column>
      <Row items="center" gap="actions" flexWrap="wrap">
        <Box w={240}><SegmentedControl options={REPLY_STYLE_DAY_OPTIONS} value={days} onChange={setDays} size="sm" /></Box>
        <Button testID="reply-style-extract-run" label={busy ? '正在提炼…' : '提炼'} variant="outline" tone="neutral" size="sm" disabled={busy} onPress={extract} />
      </Row>
      {error ? <Text testID="reply-style-extract-error" size="note" tone="danger-dark">{error}</Text> : null}
      {result ? (
        <Column testID="reply-style-preview" gap="card-row">
          {result.note ? <Text testID="reply-style-preview-note" size="note" tone="secondary">{result.note}</Text> : null}
          {result.conflicts.length ? (
            <Column testID="reply-style-conflicts" gap="text-stack">
              <Text size="label" weight="semibold">和框里不一致的地方</Text>
              {result.conflicts.map((conflict, index) => (
                <Text key={index} size="note" tone="secondary">{`框里写的是「${conflict.existing}」，最近的消息里是：${conflict.observed}`}</Text>
              ))}
            </Column>
          ) : null}
          {result.status === 'ok' && result.proposal ? (
            <Column gap="field">
              <Text size="label" weight="semibold">提炼出的风格（可以改）</Text>
              <TextField
                testID="reply-style-proposal"
                value={proposal}
                onChangeText={setProposal}
                variant="filled"
                size="sm"
                multiline
                height={120}
                maxLength={REPLY_STYLE_TEXT_MAX_LENGTH}
                accessibilityLabel="提炼出的风格"
              />
              <Text testID="reply-style-basis" size="meta" tone="muted">
                {`${replyStyleBasisLine(result)}${total !== null ? `追加以后共 ${total} / ${REPLY_STYLE_TEXT_MAX_LENGTH} 字。` : ''}`}
              </Text>
            </Column>
          ) : (
            <Text size="meta" tone="muted">{replyStyleBasisLine(result)}</Text>
          )}
          {problem ? <Text testID="reply-style-append-problem" size="note" tone="danger-dark">{problem}</Text> : null}
          {dirty ? <Text testID="reply-style-append-dirty" size="note" tone="secondary">上面的框有没保存的修改：先保存，再追加。</Text> : null}
          <Row items="center" gap="actions" flexWrap="wrap">
            {result.status === 'ok' && result.proposal ? (
              <Button
                testID="reply-style-append"
                label={appending ? '正在追加…' : '追加到代回复风格'}
                size="sm"
                disabled={appending || !proposal.trim() || problem !== null || dirty}
                onPress={append}
              />
            ) : null}
            <Button testID="reply-style-discard" label="不要" variant="ghost" tone="neutral" size="sm" onPress={() => { setResult(null); setProposal(''); }} />
          </Row>
        </Column>
      ) : null}
    </Column>
  );
}
