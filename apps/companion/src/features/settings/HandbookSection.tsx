import {
  Box, Button, Card, Chip, Column, Icon, Popover, RecordRow, Row, SegmentedControl, Switch, Text, TextField,
} from '@pi-lead-child/components';
import type {
  ChannelHandbook, ChannelHandbookDto, HandbookAbility, HandbookCapSender, HandbookMode, HandbookRehearsal, HandbookRehearsalSender,
  HandbookSituation, HandbookSuggestion, HandbookSuggestions,
} from '@pi-lead-child/protocol';
import { useEffect, useState } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useLeadName } from '@/state/hooks';

import {
  addedMeta, addProblem, capLead, capOptions, floorCountText, HANDBOOK_CAP_SENDERS, HANDBOOK_FLOORS, handbookErrorText, handbookSections,
  loosenFor, modeLabel, modeOptions, modePhrase, notInEffect, orderLine, proposalView, REHEARSAL_EXAMPLES, REHEARSAL_SENDERS, rehearsalView,
  sentenceLead, suggestionView, withAdded, withCap, withExceptionMode, withMode, withoutSituation, withSwitch, type AddInput,
} from './handbookModel';
import { ReplyStyleSection } from './ReplyStyleSection';

// 设置 → 消息通道 → 自动代你处理（交接说明，方案 B，2026-10-30，.scratch/auto-handling-handbook issue 07）。
// 你写给助手的一份交接说明，对所有外部来源生效：每种情况一句话，带下划线的短语点开选做法，选了马上保存、马上生效。
// 从上到下三张卡：开关（打开以后同一张卡里是代回复风格）；预演一条消息（收件判断真的选一句，按交接说明算结论，只读）；
// 交接说明正文（各段的句子、看对方是谁的上限、一直生效的底线、加一种情况）。
// 页边批注（issue 08，P9.6 注脚）：一句下面挂放宽的建议，「加一种情况」上面挂加一句的建议，底线下面写最近 7 天拦下几次。
// 建议只显示，你点「放宽」「加上这一句」才改（channel_handbook.accept_suggestion），点「不用」以后不再出现。
// 改、预演都是操作层的 channel_handbook（Lead 走 perform_action，调同一个函数）。助手的名字从 useLeadName 取（P14.3）。

type Message = { text: string; error: boolean };

export function HandbookSection() {
  const runtime = useCompanionRuntime();
  const [dto, setDto] = useState<ChannelHandbookDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    runtime.channelHandbook()
      .then((next) => live && setDto(next))
      .catch((reason: unknown) => live && setLoadError(handbookErrorText(reason)));
    return () => {
      live = false;
    };
  }, [runtime]);

  if (loadError) return <Text testID="handbook-error" size="note" tone="danger-dark">{`读不到自动代你处理的设置：${loadError}`}</Text>;
  if (!dto) return <Text testID="handbook-loading" size="note" tone="muted">正在读取交接说明…</Text>;
  return <Panel dto={dto} onSaved={setDto} />;
}

function Panel({ dto, onSaved }: { dto: ChannelHandbookDto; onSaved: (next: ChannelHandbookDto) => void }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const handbook = dto.handbook;
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  // 改动马上保存：交给 PUT /v1/channels/handbook，用响应替换页面上的交接说明。
  const save = (next: ChannelHandbook, done: string): Promise<boolean> => {
    setSaving(true);
    setMessage(null);
    return runtime.updateChannelHandbook(next)
      .then((saved) => {
        onSaved(saved);
        setMessage({ text: done, error: false });
        return true;
      })
      .catch((reason: unknown) => {
        setMessage({ text: `没有保存：${handbookErrorText(reason)}`, error: true });
        return false;
      })
      .finally(() => setSaving(false));
  };
  const on = handbook.autoReply;
  const pending = notInEffect(dto);
  // 页边批注读不到时不显示，不影响交接说明。
  const [suggestions, setSuggestions] = useState<HandbookSuggestions | null>(null);
  useEffect(() => {
    let live = true;
    runtime.channelHandbookSuggestions()
      .then((next) => live && setSuggestions(next))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [runtime]);
  const accept = (suggestion: HandbookSuggestion) => {
    setSaving(true);
    setMessage(null);
    runtime.acceptChannelHandbookSuggestion(suggestion.key)
      .then((next) => {
        onSaved(next.handbook);
        setSuggestions(next.suggestions);
        setMessage({ text: suggestion.kind === 'loosen' ? `已放宽：「${suggestion.situation?.text ?? ''}」。` : '已加上这一句。', error: false });
      })
      .catch((reason: unknown) => setMessage({ text: `没有改：${handbookErrorText(reason)}`, error: true }))
      .finally(() => setSaving(false));
  };
  const dismiss = (suggestion: HandbookSuggestion) => {
    runtime.dismissChannelHandbookSuggestion(suggestion.key)
      .then(setSuggestions)
      .catch((reason: unknown) => setMessage({ text: `没有记下：${handbookErrorText(reason)}`, error: true }));
  };
  const additions = suggestions?.suggestions.filter((item) => item.kind === 'add') ?? [];

  return (
    <Column testID="handbook" gap="page-section">
      <Card testID="handbook-switch-card" rounded="xl" p="page-card" gap="card-section">
        <Row items="flex-start" gap="side-item">
          <Column flex={1} minW={0} gap="text-stack">
            <Text size="card-title" weight="bold">自动代你处理</Text>
            <Text size="secondary" tone="secondary">
              {on
                ? `别人在 Slack、Jira、GitHub 上找你时，${leadName} 照下面的交接说明办。带下划线的词点一下就能改，改了马上生效。`
                : `关着：${leadName} 不代你在外面做任何事，来的消息都交给你。机器人发的、不用回的照旧只记录。`}
            </Text>
          </Column>
          <Switch
            testID="handbook-switch"
            value={on}
            label={on ? '开' : '关'}
            disabled={saving}
            onValueChange={(next) => void save(withSwitch(handbook, next), next ? '已打开：按交接说明代你处理。' : '已关掉：来的消息都交给你。')}
          />
        </Row>
        <Text testID="handbook-order" size="meta" tone="muted">{orderLine(dto, leadName)}</Text>
        {on ? (
          <>
            <Box borderTopWidth={1} borderColor="border-soft" />
            <ReplyStyleSection />
          </>
        ) : null}
      </Card>

      <RehearsalCard leadName={leadName} />

      <Card testID="handbook-letter" rounded="xl" p="page-card" gap="card-section" opacity={on ? 1 : 0.6}>
        <Column gap="text-stack">
          <Text size="card-title" weight="bold">{`给 ${leadName} 的交接说明`}</Text>
          <Text size="secondary" tone="secondary">{`${leadName}，别人在 Slack、Jira、GitHub 上找我的时候，按下面说的办。`}</Text>
        </Column>
        {message ? <Text testID="handbook-message" size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text> : null}
        {pending.length ? (
          <Text testID="handbook-pending" size="note" tone="warning-dark">
            {`这几处是 ${leadName} 写的放宽，没有生效，要你本人改：${pending.join('；')}`}
          </Text>
        ) : null}

        {handbookSections(handbook).map((group) => (
          <Column key={group.section} testID={`handbook-section-${group.section}`} gap="card-row">
            <Text size="label" tone="secondary">{group.title}</Text>
            {group.situations.map((situation) => (
              <SentenceRow
                key={situation.id}
                situation={situation}
                leadName={leadName}
                disabled={saving}
                onPick={(mode) => void save(withMode(handbook, situation.id, mode), `已保存：${sentenceLead(situation)}${modePhrase(situation, mode)}。`)}
                onPickException={(mode) => void save(withExceptionMode(handbook, situation.id, mode), `已保存：例外按「${modeLabel(mode)}」。`)}
                onRemove={situation.section === 'mine'
                  ? () => void save(withoutSituation(handbook, situation.id), `已删掉：「${situation.text}」。这类消息按「上面都不像的」处理。`)
                  : undefined}
                note={loosenFor(suggestions, situation.id)}
                onAccept={accept}
                onDismiss={dismiss}
              />
            ))}
          </Column>
        ))}

        <Column testID="handbook-caps" gap="card-row">
          <Text size="label" tone="secondary">看对方是谁</Text>
          {HANDBOOK_CAP_SENDERS.map((sender) => (
            <CapRow
              key={sender}
              sender={sender}
              mode={handbook.caps[sender]}
              leadName={leadName}
              disabled={saving}
              onPick={(mode) => void save(withCap(handbook, sender, mode), `已保存：${capLead(sender)}${modePhrase({}, mode)}。`)}
            />
          ))}
        </Column>

        <Column testID="handbook-floors" gap="card-row">
          <Row items="center" gap="icon-label">
            <Icon name="shield" size={14} color="text-secondary" />
            <Text size="label" tone="secondary">一直生效的底线（写在代码里，改不了）</Text>
          </Row>
          {HANDBOOK_FLOORS.map((floor) => {
            const count = floorCountText(suggestions, floor.id);
            return (
              <Column key={floor.id} gap="text-stack">
                <Text testID={`handbook-floor-${floor.id}`} size="body" tone="strong">{floor.text}</Text>
                {count ? <Text testID={`handbook-floor-count-${floor.id}`} size="meta" tone="muted">{count}</Text> : null}
              </Column>
            );
          })}
        </Column>

        <Box borderTopWidth={1} borderColor="border-soft" />
        {additions.map((suggestion) => (
          <MarginNote key={suggestion.key} suggestion={suggestion} disabled={saving} onAccept={accept} onDismiss={dismiss} />
        ))}
        <AddSentence leadName={leadName} disabled={saving} onAdd={(input) => save(withAdded(handbook, input), `已加上：${sentenceLead(input)}${modePhrase({}, input.mode)}。`)} />
      </Card>
    </Column>
  );
}

// 页边批注（P9.6 注脚）：一句说明，加「放宽」或「加上这一句」（默认按钮）和「不用」（文字按钮）。
function MarginNote({ suggestion, disabled, onAccept, onDismiss }: {
  suggestion: HandbookSuggestion; disabled: boolean; onAccept: (suggestion: HandbookSuggestion) => void; onDismiss: (suggestion: HandbookSuggestion) => void;
}) {
  const view = suggestionView(suggestion);
  return (
    <Column testID={`handbook-suggestion-${suggestion.key}`} gap="text-stack" pl="group-indent">
      <Text size="note" tone="secondary">{view.text}</Text>
      <Row gap="actions">
        <Button testID={`handbook-suggestion-accept-${suggestion.key}`} label={view.accept} variant="outline" tone="neutral" size="sm"
          disabled={disabled} onPress={() => onAccept(suggestion)} />
        <Button testID={`handbook-suggestion-dismiss-${suggestion.key}`} label="不用" variant="ghost" tone="neutral" size="sm"
          disabled={disabled} onPress={() => onDismiss(suggestion)} />
      </Row>
    </Column>
  );
}

// 一句话：前半截，加上带下划线的做法（点开选），加上句号。有例外时下一行是例外，也能选。你加的句子可以删。下面可能挂一条放宽的建议。
function SentenceRow({ situation, leadName, disabled, onPick, onPickException, onRemove, note, onAccept, onDismiss }: {
  situation: HandbookSituation; leadName: string; disabled: boolean;
  onPick: (mode: HandbookMode) => void; onPickException: (mode: HandbookMode) => void; onRemove?: () => void;
  note: HandbookSuggestion | null; onAccept: (suggestion: HandbookSuggestion) => void; onDismiss: (suggestion: HandbookSuggestion) => void;
}) {
  return (
    <Column testID={`handbook-sentence-${situation.id}`} gap="text-stack">
      <Row items="center" gap="side-item">
        <Row flex={1} minW={0} items="center" flexWrap="wrap">
          <Text size="body">{sentenceLead(situation)}</Text>
          <PhraseMenu
            testID={`handbook-mode-${situation.id}`}
            label={`改「${situation.text}」的做法，现在是「${modePhrase(situation, situation.mode)}」`}
            title={situation.text}
            current={situation.mode}
            options={modeOptions(leadName).map((option) => ({ ...option, phrase: modePhrase(situation, option.mode), disabled: null }))}
            disabled={disabled}
            onPick={onPick}
          />
          <Text size="body">。</Text>
        </Row>
        {onRemove ? (
          <Popover testID={`handbook-more-${situation.id}`} label={`「${situation.text}」的操作：删掉这一句`} title={situation.text} width={300}
            trigger={<Icon name="more" size={16} color="text-secondary" />}>
            {(close) => (
              <RecordRow
                testID={`handbook-remove-${situation.id}`}
                title="删掉这一句"
                detail="删掉以后，这类消息按「上面都不像的」处理。改了马上生效。"
                onPress={disabled ? undefined : () => { close(); onRemove(); }}
              />
            )}
          </Popover>
        ) : null}
      </Row>
      {situation.does && (situation.mode === 'auto' || situation.mode === 'review') ? (
        <Text size="meta" tone="muted">{`${leadName} 会${situation.does}`}</Text>
      ) : null}
      {situation.exception ? (
        <Row pl="group-indent" items="center" flexWrap="wrap">
          <Text size="body" tone="strong">{`例外：${situation.exception.text}，你`}</Text>
          <PhraseMenu
            testID={`handbook-exception-${situation.id}`}
            label={`改「${situation.text}」的例外的做法，现在是「${modePhrase(situation, situation.exception.mode)}」`}
            title={`例外：${situation.exception.text}`}
            current={situation.exception.mode}
            options={modeOptions(leadName).map((option) => ({ ...option, phrase: modePhrase(situation, option.mode), disabled: null }))}
            disabled={disabled}
            onPick={onPickException}
          />
          <Text size="body" tone="strong">。</Text>
        </Row>
      ) : null}
      {note ? <MarginNote suggestion={note} disabled={disabled} onAccept={onAccept} onDismiss={onDismiss} /> : null}
    </Column>
  );
}

function CapRow({ sender, mode, leadName, disabled, onPick }: {
  sender: HandbookCapSender; mode: HandbookMode; leadName: string; disabled: boolean; onPick: (mode: HandbookMode) => void;
}) {
  return (
    <Row testID={`handbook-cap-${sender}`} items="center" flexWrap="wrap">
      <Text size="body">{capLead(sender)}</Text>
      <PhraseMenu
        testID={`handbook-cap-mode-${sender}`}
        label={`改「${capLead(sender)}」的上限，现在是「${modePhrase({}, mode)}」`}
        title={capLead(sender)}
        current={mode}
        options={capOptions(sender, leadName).map((option) => ({ ...option, phrase: modePhrase({}, option.mode) }))}
        disabled={disabled}
        onPick={onPick}
      />
      <Text size="body">。</Text>
    </Row>
  );
}

// 带下划线的短语：强调色的字加一个向下的箭头，点开是锚定浮层（手机上是底部面板，P2、P13.2），一行一种做法。
function PhraseMenu({ testID, label, title, current, options, disabled, onPick }: {
  testID: string; label: string; title: string; current: HandbookMode; disabled: boolean;
  options: Array<{ mode: HandbookMode; phrase: string; detail: string; disabled: string | null }>;
  onPick: (mode: HandbookMode) => void;
}) {
  const selected = options.find((option) => option.mode === current);
  return (
    <Popover testID={testID} label={label} title={title} width={320}
      trigger={(
        <Row items="center" gap="text-stack">
          <Text size="body" weight="semibold" tone="accent">{selected?.phrase ?? current}</Text>
          <Icon name="chevron-down" size={14} color="accent" />
        </Row>
      )}>
      {(close) => (
        <Column>
          {options.map((option, index) => (
            <RecordRow
              key={option.mode}
              testID={`${testID}-${option.mode}`}
              divider={index > 0}
              title={option.phrase}
              detail={option.disabled ?? option.detail}
              trailing={option.mode === current ? <Icon name="check" size={16} color="accent" /> : undefined}
              onPress={disabled || option.disabled || option.mode === current ? undefined : () => { close(); onPick(option.mode); }}
            />
          ))}
          <Text size="meta" tone="muted" px="row-x" py="row-y">选了马上保存，下一条消息起生效。</Text>
        </Column>
      )}
    </Popover>
  );
}

// 加一种情况：写是什么情况（可以加一个例句），选做法，点「加上」。放在「你加的」一段。
// 「帮我整理」把第一个框里随口写的话交给便宜模型整理成一句（channel_handbook.propose，只读），填进表单，你看过再点「加上」。
function AddSentence({ leadName, disabled, onAdd }: {
  leadName: string; disabled: boolean; onAdd: (input: AddInput) => Promise<boolean>;
}) {
  const runtime = useCompanionRuntime();
  const [text, setText] = useState('');
  const [example, setExample] = useState('');
  const [mode, setMode] = useState<HandbookMode>('hand');
  // 整理出来的「会做什么」和能力：自己写的一句没有。
  const [does, setDoes] = useState('');
  const [abilities, setAbilities] = useState<HandbookAbility[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [proposing, setProposing] = useState(false);
  const reset = () => {
    setText('');
    setExample('');
    setMode('hand');
    setDoes('');
    setAbilities([]);
    setNote(null);
  };
  const add = () => {
    const found = addProblem(text, example);
    setProblem(found);
    if (found) return;
    void onAdd({ text, example, mode, does, abilities }).then((ok) => {
      if (ok) reset();
    });
  };
  const propose = () => {
    if (!text.trim()) return;
    setProposing(true);
    setProblem(null);
    setNote(null);
    runtime.proposeChannelHandbookSituation({ text: text.trim() })
      .then((result) => {
        const view = proposalView(result);
        if (view.fill) {
          setText(view.fill.text);
          setExample(view.fill.example);
          setMode(view.fill.mode);
          setDoes(view.fill.does ?? '');
          setAbilities(view.fill.abilities ?? []);
        }
        setNote(view.note);
      })
      .catch((reason: unknown) => setNote(`没有整理成：${handbookErrorText(reason)}`))
      .finally(() => setProposing(false));
  };
  const meta = addedMeta({ mode, does, abilities }, leadName);
  return (
    <Column testID="handbook-add" gap="card-row">
      <Text size="label" tone="secondary">加一种情况</Text>
      <TextField testID="handbook-add-text" value={text} onChangeText={setText} variant="filled" size="sm" maxLength={120}
        placeholder="是什么情况，可以随口写，再点「帮我整理」。例如：有人请我看线上日志" accessibilityLabel="是什么情况" />
      <TextField testID="handbook-add-example" value={example} onChangeText={setExample} variant="filled" size="sm" maxLength={120}
        placeholder="例句（可选），例如：帮我看下 tracking 服务的报错日志" accessibilityLabel="例句" />
      <Row items="center" flexWrap="wrap">
        <Text size="body" tone="strong">{`${text.trim() ? sentenceLead({ text: text.trim(), example: example.trim() || undefined }) : '这类消息，你'}`}</Text>
        <PhraseMenu
          testID="handbook-add-mode"
          label={`新的一句的做法，现在是「${modePhrase({}, mode)}」`}
          title="新的一句"
          current={mode}
          options={modeOptions(leadName).map((option) => ({ ...option, phrase: modePhrase({}, option.mode), disabled: null }))}
          disabled={disabled}
          onPick={setMode}
        />
        <Text size="body" tone="strong">。</Text>
      </Row>
      {meta ? <Text testID="handbook-add-meta" size="meta" tone="muted">{meta}</Text> : null}
      {note ? <Text testID="handbook-add-note" size="note" tone="secondary">{note}</Text> : null}
      {problem ? <Text testID="handbook-add-problem" size="note" tone="danger-dark">{problem}</Text> : null}
      <Row gap="actions">
        <Button testID="handbook-add-button" label={disabled ? '正在保存…' : '加上'} size="sm" disabled={disabled || proposing} onPress={add} />
        <Button
          testID="handbook-add-propose"
          label={proposing ? '正在整理…' : '帮我整理'}
          variant="outline"
          tone="neutral"
          size="sm"
          disabled={disabled || proposing || !text.trim()}
          onPress={propose}
        />
      </Row>
    </Column>
  );
}

// 预演一条消息：收件判断真的读一遍，再按交接说明算结论。只读，不发任何东西。
function RehearsalCard({ leadName }: { leadName: string }) {
  const runtime = useCompanionRuntime();
  const [text, setText] = useState('');
  const [sender, setSender] = useState<HandbookRehearsalSender>('colleague');
  const [result, setResult] = useState<HandbookRehearsal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    runtime.rehearseChannelHandbook({ text: text.trim(), sender })
      .then(setResult)
      .catch((reason: unknown) => setError(handbookErrorText(reason)))
      .finally(() => setBusy(false));
  };
  const view = result ? rehearsalView(result, leadName) : null;
  return (
    <Card testID="handbook-rehearsal" rounded="xl" p="page-card" gap="card-section">
      <Column gap="text-stack">
        <Text size="card-title" weight="bold">预演一条消息</Text>
        <Text size="secondary" tone="secondary">{`收件判断真的读一遍，再按下面的交接说明算出 ${leadName} 会怎么做。只读，不发任何东西。`}</Text>
      </Column>
      <Row gap="chips" flexWrap="wrap">
        {REHEARSAL_EXAMPLES.map((example) => (
          <Chip key={example} label={example} selected={text === example} onPress={() => setText(example)} />
        ))}
      </Row>
      <TextField testID="handbook-rehearsal-text" value={text} onChangeText={setText} variant="filled" size="sm" maxLength={1_500}
        placeholder="写一条别人可能发给你的消息" accessibilityLabel="要预演的消息" onSubmit={() => run()} />
      {/* 四段的字长短不一（「认不出的人」）：分段控件单独占一行，不和按钮挤在一行里被截断。 */}
      <Column gap="text-stack">
        <Text size="label" tone="secondary">对方是</Text>
        <Box w="100%">
          <SegmentedControl testID="handbook-rehearsal-sender" options={REHEARSAL_SENDERS} value={sender} onChange={setSender} size="sm" />
        </Box>
      </Column>
      <Row>
        <Button testID="handbook-rehearsal-run" label={busy ? '正在预演…' : '预演'} disabled={busy || !text.trim()} onPress={run} />
      </Row>
      {error ? <Text testID="handbook-rehearsal-error" size="note" tone="danger-dark">{`没有预演成：${error}`}</Text> : null}
      {view ? (
        <Column testID="handbook-rehearsal-result" gap="text-stack" px="inset-x" py="inset-y" rounded="lg" bg="surface-subtle">
          <Text testID="handbook-rehearsal-sentence" size="body" weight="semibold">{view.sentence}</Text>
          {view.override ? <Text testID="handbook-rehearsal-override" size="secondary" tone="warning-dark">{view.override}</Text> : null}
          {view.ruleChange ? <Text testID="handbook-rehearsal-rule-change" size="secondary" tone="warning-dark">{view.ruleChange}</Text> : null}
          <Text testID="handbook-rehearsal-outcome" size="body">{view.outcome}</Text>
          <Text size="meta" tone={view.tone}>{view.detail}</Text>
        </Column>
      ) : null}
    </Card>
  );
}
