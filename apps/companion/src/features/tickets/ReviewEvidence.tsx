// 工单详情的「核查证据」（工单 #503）：核查员截的图，排在「验收标准」和「经过与记录」（里面有交付）之间，是一个折叠行。
// 一张证据一行：左边 64 的小图（ImageThumbnail），右边写它对应的标准（「标准 1、3」）和核查员的一句说明。
// 点小图从这一张打开全屏看大图（通用的 ImageViewer）：同一组证据，左右翻页；只有一张时没有翻页和「1 / 3」，
// 第一张没有「上一张」，最后一张没有「下一张」（组件自己的规则，设计规范 A-3）。关上以后回到这一块。
// 图片的内容按需取（runtime.loadTicketReviewEvidence，取过的缓存），只在这一块展开时取。
import { Column, ImageThumbnail, ImageViewer, Row, Text, type ImageViewerItem } from '@pi-lead-child/components';
import type { ReviewEvidence, TicketAcceptanceCriteria } from '@pi-lead-child/protocol';
import { useEffect, useMemo, useState } from 'react';

import { useMessages } from '@/i18n';
import { useLeadName } from '@/state/hooks';

import { reviewEvidenceMessages } from './reviewEvidence.messages';
import type { TicketAttachmentLoader } from './TicketAttachments';

type Content = { uri: string | null; failed: boolean };
type Messages = ReturnType<typeof reviewEvidenceMessages>;
type CriterionInfo = { number: number; text: string };

// 说明里引用标准原文时最多多少字。
const CRITERION_QUOTE_MAX = 120;

/** 一张证据对应的标准，一行：「标准 1、3」。标准后来删了的写「已删掉的标准」，没有对应标准的写「没有对应的标准」。 */
export function evidenceCriteriaLabel(evidence: ReviewEvidence, numbers: ReadonlyMap<number, CriterionInfo>, m: Messages): string {
  if (!evidence.criterionIds.length) return m.noCriterion;
  const found = evidence.criterionIds.map((id) => numbers.get(id)?.number).filter((n): n is number => n !== undefined);
  const removed = evidence.criterionIds.length - found.length;
  const parts = [...(found.length ? [m.criteria([...found].sort((a, b) => a - b))] : []), ...(removed ? [m.removedCriterion] : [])];
  return parts.join(' · ');
}

/** 收着时的摘要：几张截图，对应哪几条标准。 */
export function evidenceSummary(evidence: readonly ReviewEvidence[], numbers: ReadonlyMap<number, CriterionInfo>, m: Messages): string {
  const covered = [...new Set(evidence.flatMap((entry) => entry.criterionIds.map((id) => numbers.get(id)?.number)))]
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b);
  return m.summary(evidence.length, covered.length ? m.criteria(covered) : null);
}

function criterionNumbers(criteria: TicketAcceptanceCriteria | null): Map<number, CriterionInfo> {
  return new Map((criteria?.criteria ?? []).map((criterion) => [criterion.id, { number: criterion.number, text: criterion.text }]));
}

// 取这一组证据的内容。每张取到以前是 { uri: null }；取不到时 failed。
function useEvidenceContents(load: TicketAttachmentLoader | undefined, ids: readonly string[]): Record<string, Content> {
  const [contents, setContents] = useState<Record<string, Content>>({});
  const key = ids.join(',');
  useEffect(() => {
    if (!load || !key) return undefined;
    let live = true;
    for (const id of key.split(',')) {
      load(id).then(
        (content) => { if (live) setContents((previous) => ({ ...previous, [id]: { uri: `data:${content.mimeType};base64,${content.data}`, failed: false } })); },
        () => { if (live) setContents((previous) => ({ ...previous, [id]: { uri: null, failed: true } })); },
      );
    }
    return () => { live = false; };
  }, [key, load]);
  return contents;
}

/** 折叠行里的内容：一张证据一行，点小图看大图。没有证据时不画（页面也不画这个折叠行）。 */
export function ReviewEvidenceList({ evidence, criteria, load }: {
  evidence: readonly ReviewEvidence[];
  criteria: TicketAcceptanceCriteria | null;
  load?: TicketAttachmentLoader;
}) {
  const m = useMessages(reviewEvidenceMessages);
  const leadName = useLeadName();
  const numbers = useMemo(() => criterionNumbers(criteria), [criteria]);
  const ids = useMemo(() => evidence.map((entry) => entry.id), [evidence]);
  const contents = useEvidenceContents(load, ids);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  if (!evidence.length) return null;

  const items: ImageViewerItem[] = evidence.map((entry) => {
    const label = evidenceCriteriaLabel(entry, numbers, m);
    const quotes = entry.criterionIds
      .map((id) => numbers.get(id))
      .filter((info): info is CriterionInfo => Boolean(info))
      .sort((a, b) => a.number - b.number)
      .map((info) => `${info.number}. ${clip(info.text, CRITERION_QUOTE_MAX)}`);
    const later = entry.addedBy === 'reviewer' ? null : m.addedLater(entry.addedBy === 'lead' ? leadName : m.you);
    return {
      key: entry.id,
      uri: contents[entry.id]?.uri ?? null,
      failed: contents[entry.id]?.failed ?? false,
      label: `${label} · ${entry.name}`,
      title: label,
      caption: [entry.caption, ...quotes, later].filter(Boolean).join('\n'),
    };
  });

  return (
    <Column testID="ticket-review-evidence" gap="card-row">
      {evidence.map((entry, index) => (
        <Row key={entry.id} testID={`ticket-review-evidence-${index}`} gap="card-row" items="flex-start">
          <ImageThumbnail
            testID={`ticket-review-evidence-thumb-${index}`}
            uri={contents[entry.id]?.uri ?? null}
            failed={contents[entry.id]?.failed ?? false}
            label={m.openImage(items[index]!.label)}
            onPress={() => setOpenIndex(index)}
          />
          <Column flex={1} minW={0} gap="text-stack">
            <Text size="label" weight="semibold" testID={`ticket-review-evidence-criteria-${index}`}>{items[index]!.title}</Text>
            {entry.caption ? <Text size="secondary" tone="secondary" numberOfLines={3}>{entry.caption}</Text> : null}
            <Text size="meta" tone="muted" numberOfLines={1}>{entry.name}</Text>
          </Column>
        </Row>
      ))}
      <ImageViewer
        testID="ticket-review-evidence-viewer"
        open={openIndex !== null}
        items={items}
        initialIndex={openIndex ?? 0}
        onClose={() => setOpenIndex(null)}
      />
    </Column>
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
